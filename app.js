/**
 * Stateless helpers shared by both graph views.
 */
class GraphUtils {
    /**
     * Compare dotted numeric versions without needing full semver parsing.
     */
    static semverCompare(a, b) {
        let av = a.split(".");
        let bv = b.split(".");

        for (let i = 0; i < Math.min(av.length, bv.length); i++) {
            let ac = parseInt(av[i], 10);
            let bc = parseInt(bv[i], 10);
            let r = ac - bc;
            if (r !== 0) {
                return r;
            }
        }

        return 0;
    }

    /**
     * Check whether a release belongs to the current major/minor stream.
     */
    static isStreamVersion(streamVersion, version) {
        if (streamVersion === null) {
            return false;
        }

        let v = version.split(".");
        return streamVersion.major === v[0] && streamVersion.minor === v[1];
    }

    static isHotfix(version) {
        return version.includes("hotfix");
    }

    /**
     * Extract the major.minor portion of a version label for grouping.
     */
    static majorMinorKey(version) {
        let match = /^([0-9]+\.[0-9]+)/.exec(version);
        return match ? match[1] : version;
    }

    /**
     * Convert a stream identifier into the major/minor pair used for filtering.
     */
    static streamVersion(streamId) {
        let s = /.*-([0-9]+)\.([0-9]+)/.exec(streamId);
        if (s) {
            return { major: s[1], minor: s[2] };
        }

        return null;
    }

    /**
     * Order stream ids by parsed major/minor version before falling back to the raw name.
     */
    static compareStreamNames(a, b) {
        let aVersion = GraphUtils.streamVersion(a);
        let bVersion = GraphUtils.streamVersion(b);

        if (aVersion && bVersion) {
            let majorDiff = parseInt(aVersion.major, 10) - parseInt(bVersion.major, 10);
            if (majorDiff !== 0) {
                return majorDiff;
            }

            let minorDiff = parseInt(aVersion.minor, 10) - parseInt(bVersion.minor, 10);
            if (minorDiff !== 0) {
                return minorDiff;
            }
        }

        return a.localeCompare(b);
    }

    /**
     * Project an edge onto the border of the rounded node box instead of its center.
     */
    static edgeEndpoint(from, to, inset) {
        let dx = to.x - from.x;
        let dy = to.y - from.y;
        let length = Math.hypot(dx, dy);

        if (!length) {
            return { x: from.x, y: from.y };
        }

        let halfWidth = from.node_width / 2;
        let halfHeight = from.node_height / 2;
        let scale = 1 / Math.max(Math.abs(dx) / halfWidth, Math.abs(dy) / halfHeight);
        let distance = Math.max(0, (length * scale) - inset);

        return {
            x: from.x + (dx / length) * distance,
            y: from.y + (dy / length) * distance,
        };
    }

    static nodeFill(node) {
        return node.is_most_recent ? "#95c3ff" : "#CCCCCC";
    }

    static edgeColor(edge, selectedId) {
        if (!selectedId) {
            return "#DDDDDD";
        }
        if (edge.source.id === selectedId) {
            return "#7bc084";
        }
        if (edge.target.id === selectedId) {
            return "#efdf29";
        }
        return "#DDDDDD";
    }

    static edgeOpacity(edge, selectedId) {
        if (!selectedId) {
            return 0.75;
        }
        if (edge.source.id === selectedId || edge.target.id === selectedId) {
            return 1;
        }
        return 0.18;
    }

    static nodeSpacingRadius(node) {
        return node.node_collision_radius + 10;
    }

    /**
     * Approximate how far the force simulation has progressed toward its resting state.
     */
    static simulationProgress(simulation, initialAlpha) {
        let alpha = Math.max(simulation.alpha(), simulation.alphaMin());
        let start = Math.max(initialAlpha, simulation.alphaMin());
        let end = simulation.alphaMin();

        if (start <= end) {
            return 1;
        }

        return Math.log(start / alpha) / Math.log(start / end);
    }
}

/**
 * Coordinates data loading, UI state, and graph rendering for the page.
 */
class OpenShiftUpdateGraphApp {
    constructor(options) {
        this.defaultStream = options.defaultStream;
        this.openshiftCliPubMirror = options.openshiftCliPubMirror;
        this.graphState = null;
        this.currentGraphData = null;
        this.currentSelectedNodeId = null;
        this.currentSearchTerm = "";
        this.activeView = "force";
        this.textMeasureContext = null;
        this.versionMapWorker = null;
        this.versionMapRequestId = 0;
        this.networkMostRecent = null;
        this.currentChannel = null;
        this.currentStreamVersion = null;
    }

    /**
     * Wire page controls to the controller instance and trigger the initial load.
     */
    init() {
        $("#version-search").on("input", (event) => {
            this.setSearchTerm($(event.currentTarget).val());
        });
        $("#version-search-clear").on("click", () => {
            this.clearSearch();
        });
        $(document).on("keydown", (event) => {
            this.handleGlobalKeydown(event);
        });

        $("#streams").change(() => {
            $("#streams option:selected").each((_, option) => {
                this.load($(option).attr("value"));
            });
        });

        $("#graph-tabs .nav-link").click((event) => {
            this.setActiveView($(event.currentTarget).data("view"));
        });

        this.setActiveView(this.activeView);
        this.updateStreams();
    }

    failure(msg) {
        console.log("Failure:", msg);

        let alert = $('<div class="mt-3 failure alert alert-danger alert-dismissible fade show" role="alert">' +
            '<strong>Failure!</strong> <span class="msg"></span>' +
            '  <button type="button" class="close" data-dismiss="alert" aria-label="Close">\n' +
            '    <span aria-hidden="true">&times;</span>\n' +
            "  </button>" +
            "</div>");

        alert.find(".msg").text(msg);

        $("main").append(alert);
        alert.alert();
    }

    /**
     * Measure the current graph container so both views can fill the available panel.
     */
    graphDimensions() {
        let container = document.getElementById("graph");
        let rect = container.getBoundingClientRect();
        return {
            width: Math.max(rect.width, 320),
            height: Math.max(rect.height, 320),
        };
    }

    setGraphScrollMode(enabled) {
        d3.select("#graph").style("overflow", enabled ? "auto" : "hidden");
    }

    /**
     * Tear down the active view before switching streams or render modes.
     */
    stopGraph() {
        if (this.graphState && this.graphState.simulation) {
            this.graphState.simulation.stop();
        }
        if (this.graphState && this.graphState.resizeHandler) {
            window.removeEventListener("resize", this.graphState.resizeHandler);
        }
        this.graphState = null;
        this.setGraphScrollMode(false);
        d3.select("#graph").selectAll("*").remove();
    }

    /**
     * Lazily create the worker so the classic view does not pay for it up front.
     */
    ensureVersionMapWorker() {
        if (this.versionMapWorker || typeof Worker === "undefined") {
            return this.versionMapWorker;
        }

        this.versionMapWorker = new Worker("version-map-worker.js");
        return this.versionMapWorker;
    }

    /**
     * Cancel layered-layout work and invalidate any late worker responses.
     */
    cancelVersionMapWork() {
        this.versionMapRequestId += 1;

        if (this.versionMapWorker) {
            this.versionMapWorker.terminate();
            this.versionMapWorker = null;
        }
    }

    /**
     * Switch between render modes and cancel layered layout work when leaving that view.
     */
    setActiveView(view) {
        if (this.activeView === "version-map" && view !== "version-map") {
            this.cancelVersionMapWork();
            this.setProgress(1);
        }

        this.activeView = view;

        $("#graph-tabs .nav-link").removeClass("active");
        $("#graph-tabs .nav-link[data-view='" + view + "']").addClass("active");

        this.renderCurrentGraph();
    }

    /**
     * Re-render the current dataset using whichever view is active.
     */
    renderCurrentGraph() {
        if (!this.currentGraphData) {
            return;
        }

        if (this.activeView === "version-map") {
            this.renderVersionMap(this.currentGraphData);
            return;
        }

        if (this.activeView === "tangled-tree") {
            this.renderTangledTree(this.currentGraphData);
            return;
        }

        this.renderForceGraph(this.currentGraphData);
        if (this.graphState) {
            this.graphState.selected_node_id = this.currentSelectedNodeId;
        }
        this.updateSelection();
    }

    /**
     * Coalesce simulation ticks into a single DOM update per animation frame.
     */
    scheduleGraphRender() {
        if (!this.graphState || this.graphState.render_pending) {
            return;
        }
        this.graphState.render_pending = true;
        window.requestAnimationFrame(() => {
            if (!this.graphState) {
                return;
            }
            this.graphState.render_pending = false;
            this.renderGraphNow();
        });
    }

    renderGraphNow() {
        if (this.graphState && this.graphState.render_now) {
            this.graphState.render_now();
        }
    }

    /**
     * Reuse a hidden canvas context so text measurement stays cheap.
     */
    estimateTextWidth(text) {
        if (this.textMeasureContext === null) {
            let canvas = document.createElement("canvas");
            this.textMeasureContext = canvas.getContext("2d");
            this.textMeasureContext.font = "11px sans-serif";
        }

        return this.textMeasureContext.measureText(text).width;
    }

    /**
     * Cache text-derived node sizes once so both renderers can reuse them.
     */
    ensureNodeMetrics(graphData) {
        graphData.nodes.forEach((node) => {
            if (node.node_width !== undefined) {
                return;
            }

            let textWidth = this.estimateTextWidth(node.label);
            node.node_width = Math.max(38, Math.ceil(textWidth + 18));
            node.node_height = 22;
            node.node_radius = Math.ceil(node.node_height / 2);
            node.node_collision_radius = Math.ceil(Math.max(node.node_width, node.node_height) / 2) + 4;
        });
    }

    /**
     * Apply selection and search highlighting consistently across both graph views.
     */
    updateGraphStyles() {
        if (!this.graphState) {
            return;
        }

        let selectedId = this.graphState.selected_node_id;
        let related = selectedId ? this.graphState.related_node_ids[selectedId] : null;
        let hasSearch = this.currentSearchTerm.length > 0;
        let isHighlightedEdge = (edge) => {
            if (!selectedId) {
                return false;
            }

            return edge.source.id === selectedId || edge.target.id === selectedId;
        };

        if (this.graphState.view_type === "version-map") {
            this.graphState.link
                .attr("stroke", "#DDDDDD")
                .attr("stroke-dasharray", null)
                .attr("stroke-opacity", 0.75);
        } else {
            this.graphState.link
                .attr("stroke", (d) => GraphUtils.edgeColor(d, selectedId))
                .attr("stroke-dasharray", (d) => {
                    if (selectedId && d.target.id === selectedId) {
                        return "4 3";
                    }
                    return null;
                })
                .attr("stroke-opacity", (d) => GraphUtils.edgeOpacity(d, selectedId));
        }

        if (this.graphState.view_type === "tangled-tree") {
            this.graphState.link
                .sort((a, b) => {
                    let aHighlighted = isHighlightedEdge(a) ? 1 : 0;
                    let bHighlighted = isHighlightedEdge(b) ? 1 : 0;
                    return aHighlighted - bHighlighted;
                });
        }

        this.graphState.node_shape
            .attr("fill", (d) => {
                if (this.nodeMatchesSearch(d)) {
                    return "#ffd89b";
                }
                return GraphUtils.nodeFill(d);
            })
            .attr("stroke", (d) => {
                if (d.id === selectedId) {
                    return "#222222";
                }
                if (this.nodeMatchesSearch(d)) {
                    return "#c97a00";
                }
                if (related && related.has(d.id)) {
                    return "#5a5a5a";
                }
                return "#BBBBBB";
            })
            .attr("stroke-width", (d) => (d.id === selectedId ? 2.5 : 1.2))
            .attr("opacity", (d) => {
                if (!selectedId) {
                    if (hasSearch) {
                        return this.nodeMatchesSearch(d) ? 1 : 0.35;
                    }
                    return 1;
                }
                if (d.id === selectedId || related.has(d.id)) {
                    return 1;
                }
                if (hasSearch && this.nodeMatchesSearch(d)) {
                    return 0.9;
                }
                return 0.3;
            });

        this.graphState.node_text
            .attr("opacity", (d) => {
                if (!selectedId) {
                    if (hasSearch) {
                        return this.nodeMatchesSearch(d) ? 1 : 0.25;
                    }
                    return d.is_most_recent ? 1 : 0.75;
                }
                if (d.id === selectedId || related.has(d.id)) {
                    return 1;
                }
                if (hasSearch && this.nodeMatchesSearch(d)) {
                    return 0.9;
                }
                return 0.2;
            })
            .attr("fill", (d) => {
                if (d.id === selectedId) {
                    return "#111111";
                }
                if (this.nodeMatchesSearch(d)) {
                    return "#7a4a00";
                }
                return "#404040";
            })
            .attr("font-weight", (d) => ((d.id === selectedId || d.is_most_recent || this.nodeMatchesSearch(d)) ? "600" : "400"));
    }

    /**
     * Sync the side panel with the currently selected node, or the channel overview.
     */
    updateSelection() {
        let node = null;

        if (this.graphState && this.graphState.selected_node_id !== null) {
            node = this.graphState.nodes_by_id[this.graphState.selected_node_id];
        }

        if (node !== null) {
            this.setInfo("Version", node.label, node.from_versions, node.to_versions, node.data.errata);
        } else {
            this.setInfo();
        }

        this.updateGraphStyles();
    }

    /**
     * Persist the selected node so it survives re-renders and view switches.
     */
    selectNode(nodeId) {
        this.currentSelectedNodeId = nodeId;

        if (!this.graphState) {
            return;
        }

        this.graphState.selected_node_id = nodeId;
        this.updateSelection();
    }

    /**
     * Match search queries with a case-insensitive substring check against the node label.
     */
    nodeMatchesSearch(node) {
        if (!this.currentSearchTerm) {
            return false;
        }

        return node.label.toLowerCase().includes(this.currentSearchTerm);
    }

    setSearchTerm(value) {
        this.currentSearchTerm = (value || "").toString().trim().toLowerCase();
        this.updateGraphStyles();
    }

    focusSearch() {
        let search = $("#version-search");
        search.trigger("focus");
        search.trigger("select");
    }

    clearSearch() {
        $("#version-search").val("");
        this.setSearchTerm("");
        this.focusSearch();
    }

    handleGlobalKeydown(event) {
        let target = event.target;
        let tagName = target && target.tagName ? target.tagName.toLowerCase() : "";
        let isEditable = tagName === "input" ||
            tagName === "textarea" ||
            tagName === "select" ||
            (target && target.isContentEditable);

        if (!isEditable && event.key === "/") {
            event.preventDefault();
            this.focusSearch();
        }
    }

    /**
     * Normalize the raw stream payload into the node/link structure both renderers expect.
     */
    buildGraphData(data) {
        let nodes = [];
        let nodesById = {};
        let mostRecent = null;

        for (let i = 0; i < data.nodes.length; i++) {
            let node = data.nodes[i];
            let id = "" + i;

            if (!GraphUtils.isHotfix(node.version) &&
                this.currentStreamVersion &&
                GraphUtils.isStreamVersion(this.currentStreamVersion, node.version) &&
                (mostRecent === null || GraphUtils.semverCompare(mostRecent.version, node.version) < 0)) {
                mostRecent = { version: node.version, index: i };
            }

            let graphNode = {
                id: id,
                label: node.version,
                data: {
                    errata: node.metadata.url,
                },
                from_versions: [],
                to_versions: [],
                incoming_ids: new Set(),
                outgoing_ids: new Set(),
                is_most_recent: false,
            };

            nodes.push(graphNode);
            nodesById[id] = graphNode;
        }

        let links = data.edges.map((path) => {
            let source = "" + path[0];
            let target = "" + path[1];
            let sourceNode = nodesById[source];
            let targetNode = nodesById[target];

            sourceNode.to_versions.push(targetNode.label);
            sourceNode.outgoing_ids.add(target);
            targetNode.from_versions.push(sourceNode.label);
            targetNode.incoming_ids.add(source);

            return {
                source: source,
                target: target,
            };
        });

        nodes.forEach((node) => {
            node.from_versions.sort(GraphUtils.semverCompare);
            node.to_versions.sort(GraphUtils.semverCompare);
        });

        if (mostRecent !== null) {
            nodesById["" + mostRecent.index].is_most_recent = true;
        }

        let relatedNodeIds = {};
        nodes.forEach((node) => {
            relatedNodeIds[node.id] = new Set([
                ...node.incoming_ids,
                ...node.outgoing_ids,
            ]);
        });

        return {
            nodes: nodes,
            nodes_by_id: nodesById,
            links: links,
            related_node_ids: relatedNodeIds,
            most_recent: mostRecent,
        };
    }

    /**
     * Build a fresh SVG root with zooming and a reusable arrowhead marker definition.
     */
    initializeGraphSvg(dimensions, options = {}) {
        let stretchToContainer = options.stretchToContainer !== false;
        let svg = d3.select("#graph")
            .append("svg")
            .attr("viewBox", "0 0 " + dimensions.width + " " + dimensions.height)
            .attr("width", dimensions.width)
            .attr("height", dimensions.height)
            .style("width", "100%")
            .style("height", stretchToContainer ? "100%" : (dimensions.height + "px"))
            .style("cursor", "grab");

        let root = svg.append("g");

        let zoom = d3.zoom()
            .scaleExtent([0.2, 4])
            .on("zoom", (event) => {
                this.dismissGraphLoading();
                root.attr("transform", event.transform);
            });

        svg.call(zoom);
        svg.call(
            zoom.transform,
            d3.zoomIdentity
                .translate(dimensions.width / 2, dimensions.height / 2)
                .scale(1.5)
                .translate(-dimensions.width / 2, -dimensions.height / 2)
        );

        svg.on("click", () => {
            this.dismissGraphLoading();
            this.selectNode(null);
        });

        let defs = svg.append("defs");
        defs.append("marker")
            .attr("id", "arrowhead")
            .attr("viewBox", "0 -5 10 10")
            .attr("refX", 10)
            .attr("refY", 0)
            .attr("markerWidth", 6)
            .attr("markerHeight", 6)
            .attr("orient", "auto")
            .append("path")
            .attr("fill", "context-stroke")
            .attr("d", "M0,-5L10,0L0,5");

        return {
            svg: svg,
            root: root,
        };
    }

    /**
     * Render the shared node visuals used by both the force and layered views.
     */
    createGraphNodes(root, graphData, dragBehavior) {
        this.ensureNodeMetrics(graphData);

        let node = root.append("g")
            .selectAll("g")
            .data(graphData.nodes)
            .join("g")
            .style("cursor", "pointer")
            .on("click", (event, d) => {
                event.stopPropagation();
                this.dismissGraphLoading();
                this.selectNode(d.id);
            });

        if (dragBehavior) {
            node.call(dragBehavior);
        }

        let nodeText = node.append("text")
            .text((d) => d.label)
            .attr("font-size", 11)
            .attr("fill", "#404040")
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "central")
            .attr("pointer-events", "none");

        let nodeShape = node.insert("rect", "text")
            .attr("x", (d) => -d.node_width / 2)
            .attr("y", (d) => -d.node_height / 2)
            .attr("width", (d) => d.node_width)
            .attr("height", (d) => d.node_height)
            .attr("rx", (d) => d.node_radius)
            .attr("ry", (d) => d.node_radius)
            .attr("fill", (d) => GraphUtils.nodeFill(d))
            .attr("stroke", "#BBBBBB")
            .attr("stroke-width", 1.2);

        node.append("title")
            .text((d) => d.label);

        return {
            node: node,
            node_shape: nodeShape,
            node_text: nodeText,
        };
    }

    /**
     * Build stable x-axis centers for each major.minor group in the classic force layout.
     */
    buildMajorMinorCenters(graphData, dimensions) {
        let groupKeys = Array.from(new Set(
            graphData.nodes.map((node) => GraphUtils.majorMinorKey(node.label))
        )).sort(GraphUtils.semverCompare);
        let spacing = dimensions.width / (groupKeys.length + 1);
        let centers = new Map();

        groupKeys.forEach((groupKey, index) => {
            centers.set(groupKey, {
                x: spacing * (index + 1),
                y: dimensions.height / 2,
            });
        });

        return centers;
    }

    /**
     * Cache a left-to-right layered layout with relaxed row ordering for the tangled-tree tab.
     */
    buildTangledTreeLayout(graphData) {
        if (graphData.tangled_tree_layout) {
            return graphData.tangled_tree_layout;
        }

        this.ensureNodeMetrics(graphData);

        let nodes = graphData.nodes.slice();
        let pendingParents = new Map();
        let depthById = new Map();
        let queue = [];

        nodes.forEach((node) => {
            pendingParents.set(node.id, node.incoming_ids.size);
            if (node.incoming_ids.size === 0) {
                depthById.set(node.id, 0);
                queue.push(node);
            }
        });

        while (queue.length > 0) {
            let node = queue.shift();
            let depth = depthById.get(node.id) || 0;

            node.outgoing_ids.forEach((targetId) => {
                let nextDepth = depth + 1;
                depthById.set(targetId, Math.max(depthById.get(targetId) || 0, nextDepth));
                pendingParents.set(targetId, pendingParents.get(targetId) - 1);

                if (pendingParents.get(targetId) === 0) {
                    queue.push(graphData.nodes_by_id[targetId]);
                }
            });
        }

        nodes.forEach((node) => {
            if (!depthById.has(node.id)) {
                depthById.set(node.id, 0);
            }
        });

        let layers = [];
        nodes.forEach((node) => {
            let depth = depthById.get(node.id);
            if (!layers[depth]) {
                layers[depth] = [];
            }
            layers[depth].push(node);
        });

        layers.forEach((layer) => {
            layer.sort((a, b) => GraphUtils.semverCompare(a.label, b.label));
        });

        let orderById = new Map();
        let refreshLayerOrders = () => {
            layers.forEach((layer) => {
                layer.forEach((node, index) => {
                    orderById.set(node.id, index);
                });
            });
        };

        let averageNeighborOrder = (node, neighborIds) => {
            if (neighborIds.size === 0) {
                return orderById.get(node.id) || 0;
            }

            let total = 0;
            let count = 0;
            neighborIds.forEach((neighborId) => {
                if (orderById.has(neighborId)) {
                    total += orderById.get(neighborId);
                    count += 1;
                }
            });

            if (count === 0) {
                return orderById.get(node.id) || 0;
            }

            return total / count;
        };

        refreshLayerOrders();
        for (let pass = 0; pass < 4; pass++) {
            for (let depth = 1; depth < layers.length; depth++) {
                layers[depth].sort((a, b) => {
                    let diff = averageNeighborOrder(a, a.incoming_ids) - averageNeighborOrder(b, b.incoming_ids);
                    if (diff !== 0) {
                        return diff;
                    }
                    return GraphUtils.semverCompare(a.label, b.label);
                });
                refreshLayerOrders();
            }

            for (let depth = layers.length - 2; depth >= 0; depth--) {
                layers[depth].sort((a, b) => {
                    let diff = averageNeighborOrder(a, a.outgoing_ids) - averageNeighborOrder(b, b.outgoing_ids);
                    if (diff !== 0) {
                        return diff;
                    }
                    return GraphUtils.semverCompare(a.label, b.label);
                });
                refreshLayerOrders();
            }
        }

        let layoutNodes = [];
        let layoutNodeById = {};
        let maxLayerSize = layers.reduce((maxSize, layer) => Math.max(maxSize, layer ? layer.length : 0), 0);
        let layerHeight = Math.max(1, maxLayerSize - 1);

        layers.forEach((layer, depth) => {
            if (!layer) {
                return;
            }

            let centerOffset = (layerHeight - (layer.length - 1)) / 2;
            layer.forEach((node, index) => {
                let layoutNode = {
                    id: node.id,
                    x_rank: depth,
                    y_rank: centerOffset + index,
                };

                layoutNodes.push(layoutNode);
                layoutNodeById[node.id] = layoutNode;
            });
        });

        let bundleOffsetsByRank = new Map();
        let layoutLinks = graphData.links.map((link) => {
            let sourceId = typeof link.source === "string" ? link.source : link.source.id;
            let targetId = typeof link.target === "string" ? link.target : link.target.id;
            let sourceLayout = layoutNodeById[sourceId];
            let targetLayout = layoutNodeById[targetId];
            let rank = Math.min(sourceLayout.x_rank, targetLayout.x_rank);

            if (!bundleOffsetsByRank.has(rank)) {
                bundleOffsetsByRank.set(rank, 0);
            }

            let localIndex = bundleOffsetsByRank.get(rank);
            bundleOffsetsByRank.set(rank, localIndex + 1);

            return {
                source_id: sourceId,
                target_id: targetId,
                rank: rank,
                bundle_offset_rank: localIndex,
            };
        });

        graphData.tangled_tree_layout = {
            depth_count: Math.max(1, layers.length),
            row_count: Math.max(1, maxLayerSize),
            nodes: layoutNodes,
            links: layoutLinks,
            max_bundle_count: Math.max(1, Math.max(...Array.from(bundleOffsetsByRank.values(), (count) => count), 1)),
        };

        return graphData.tangled_tree_layout;
    }

    /**
     * Render the animated force-directed view and keep its simulation state alive.
     */
    renderForceGraph(graphData) {
        this.stopGraph();
        this.setProgress(0);

        let dimensions = this.graphDimensions();
        let majorMinorCenters = this.buildMajorMinorCenters(graphData, dimensions);
        let canvas = this.initializeGraphSvg(dimensions);
        let root = canvas.root;
        canvas.svg.style("visibility", "hidden");

        let link = root.append("g")
            .attr("stroke-linecap", "round")
            .selectAll("line")
            .data(graphData.links)
            .join("line")
            .attr("stroke", "#DDDDDD")
            .attr("stroke-width", 1.2)
            .attr("marker-end", "url(#arrowhead)");

        let nodeParts = this.createGraphNodes(
            root,
            graphData,
            d3.drag()
                .on("start", (event, d) => {
                    d.was_dragged = false;
                    d.fx = d.x;
                    d.fy = d.y;
                })
                .on("drag", (event, d) => {
                    if (!d.was_dragged) {
                        d.was_dragged = true;
                        this.graphState.simulation.alphaTarget(0.12).restart();
                    }
                    d.fx = event.x;
                    d.fy = event.y;
                })
                .on("end", (event, d) => {
                    if (d.was_dragged && !event.active) {
                        this.graphState.simulation.alphaTarget(0);
                    }
                    d.fx = null;
                    d.fy = null;
                    d.was_dragged = false;
                })
        );

        let simulation = d3.forceSimulation(graphData.nodes)
            .force("link", d3.forceLink(graphData.links).id((d) => d.id).distance(42).strength(0.35))
            .force("charge", d3.forceManyBody().strength(-110).theta(0.9).distanceMax(500))
            .force("collide", d3.forceCollide().radius(GraphUtils.nodeSpacingRadius).iterations(2).strength(0.9))
            .force("center", d3.forceCenter(dimensions.width / 2, dimensions.height / 2))
            .alphaDecay(0.06)
            .velocityDecay(0.45)
            .force("group-x", d3.forceX((node) => majorMinorCenters.get(GraphUtils.majorMinorKey(node.label)).x).strength(0.22))
            .force("group-y", d3.forceY((node) => majorMinorCenters.get(GraphUtils.majorMinorKey(node.label)).y).strength(0.06));

        this.graphState = {
            svg: canvas.svg,
            simulation: simulation,
            view_type: "force",
            initial_alpha: simulation.alpha(),
            node: nodeParts.node,
            node_shape: nodeParts.node_shape,
            node_text: nodeParts.node_text,
            link: link,
            nodes_by_id: graphData.nodes_by_id,
            related_node_ids: graphData.related_node_ids,
            selected_node_id: null,
            progress_enabled: true,
            render_pending: false,
            revealed: false,
            loading_dismissed: false,
            render_now: () => {
                this.graphState.link
                    .attr("x1", (d) => GraphUtils.edgeEndpoint(d.source, d.target, 0).x)
                    .attr("y1", (d) => GraphUtils.edgeEndpoint(d.source, d.target, 0).y)
                    .attr("x2", (d) => GraphUtils.edgeEndpoint(d.target, d.source, 0).x)
                    .attr("y2", (d) => GraphUtils.edgeEndpoint(d.target, d.source, 0).y);

                this.graphState.node
                    .attr("transform", (d) => "translate(" + d.x + "," + d.y + ")");
            },
            resizeHandler: () => {
                if (!this.graphState) {
                    return;
                }

                let nextDimensions = this.graphDimensions();
                this.graphState.svg
                    .attr("viewBox", "0 0 " + nextDimensions.width + " " + nextDimensions.height)
                    .attr("width", nextDimensions.width)
                    .attr("height", nextDimensions.height);
                this.graphState.simulation.force("center", d3.forceCenter(nextDimensions.width / 2, nextDimensions.height / 2));
                this.graphState.simulation.alpha(0.2).restart();
            }
        };

        window.addEventListener("resize", this.graphState.resizeHandler);

        simulation.on("tick", () => {
            if (this.graphState && this.graphState.progress_enabled) {
                let progress = GraphUtils.simulationProgress(simulation, this.graphState.initial_alpha);
                this.setProgress(Math.max(0, Math.min(progress, 0.99)));

                if (!this.graphState.revealed && progress >= 0.8) {
                    this.graphState.revealed = true;
                    this.graphState.svg.style("visibility", "visible");
                    $("#graph-loading-text").text("Finalizing layout.");
                }
            }
            this.scheduleGraphRender();
        });

        simulation.on("end", () => {
            if (this.graphState) {
                this.graphState.progress_enabled = false;
                if (!this.graphState.revealed) {
                    this.graphState.revealed = true;
                    this.graphState.svg.style("visibility", "visible");
                }
            }
            this.renderGraphNow();
            this.setProgress(1);
        });

        this.updateGraphStyles();
    }

    /**
     * Compute and cache layered coordinates in graphData for reuse across resizes.
     */
    buildSugiyamaLayout(graphData) {
        if (graphData.version_map_layout) {
            return graphData.version_map_layout;
        }

        this.ensureNodeMetrics(graphData);

        let dagInput = graphData.nodes.map((node) => ({
            id: node.id,
            parentIds: Array.from(node.incoming_ids),
            node: node,
        }));

        let stratify = d3.graphStratify()
            .id((d) => d.id)
            .parentIds((d) => d.parentIds);

        let dag = stratify(dagInput);
        let layout = d3.sugiyama()
            .layering(d3.layeringLongestPath())
            .decross(d3.decrossTwoLayer())
            .coord(d3.coordGreedy())
            .nodeSize((node) => [node.data.node.node_width + 56, node.data.node.node_height + 32]);

        let layoutSize = layout(dag);
        graphData.version_map_layout = {
            width: layoutSize.width,
            height: layoutSize.height,
            nodes: Array.from(dag.nodes()).map((dagNode) => ({
                id: dagNode.data.node.id,
                x: dagNode.x,
                y: dagNode.y,
            })),
            links: Array.from(dag.links()).map((link) => ({
                source_id: link.source.data.node.id,
                target_id: link.target.data.node.id,
                points: link.points.map((point) => ({
                    x: point.x,
                    y: point.y,
                })),
            })),
        };

        return graphData.version_map_layout;
    }

    /**
     * Compute layered coordinates asynchronously when a worker is available.
     */
    buildSugiyamaLayoutAsync(graphData) {
        if (graphData.version_map_layout) {
            return Promise.resolve(graphData.version_map_layout);
        }

        this.ensureNodeMetrics(graphData);

        let worker = this.ensureVersionMapWorker();
        if (!worker) {
            return Promise.resolve(this.buildSugiyamaLayout(graphData));
        }

        this.versionMapRequestId += 1;
        let requestId = this.versionMapRequestId;

        return new Promise((resolve, reject) => {
            let handleMessage = (event) => {
                let message = event.data;
                if (message.requestId !== requestId) {
                    return;
                }

                if (!message.layout && !message.error) {
                    return;
                }

                worker.removeEventListener("message", handleMessage);
                worker.removeEventListener("error", handleError);

                if (message.error) {
                    reject(new Error(message.error));
                    return;
                }

                graphData.version_map_layout = message.layout;
                resolve(message.layout);
            };

            let handleError = (event) => {
                worker.removeEventListener("message", handleMessage);
                worker.removeEventListener("error", handleError);
                reject(new Error(event.message || "Failed to compute version map layout"));
            };

            worker.addEventListener("message", handleMessage);
            worker.addEventListener("error", handleError);
            worker.postMessage({
                requestId: requestId,
                nodes: graphData.nodes.map((node) => ({
                    id: node.id,
                    parentIds: Array.from(node.incoming_ids),
                    nodeWidth: node.node_width,
                    nodeHeight: node.node_height,
                })),
            });
        });
    }

    /**
     * Scale cached layout coordinates into the current viewport with fixed padding.
     */
    applySugiyamaLayout(graphData, dimensions) {
        let layout = this.buildSugiyamaLayout(graphData);
        let horizontalPadding = 64;
        let verticalPadding = 48;
        let availableWidth = dimensions.width - (horizontalPadding * 2);
        let availableHeight = dimensions.height - (verticalPadding * 2);
        let widthScale = layout.width > 0 ? availableWidth / layout.width : 1;
        let heightScale = layout.height > 0 ? availableHeight / layout.height : 1;
        let scale = Math.max(1, Math.min(widthScale, heightScale));
        let offsetX = horizontalPadding + Math.max(0, (availableWidth - (layout.width * scale)) / 2);
        let offsetY = verticalPadding + Math.max(0, (availableHeight - (layout.height * scale)) / 2);

        layout.nodes.forEach((layoutNode) => {
            let node = graphData.nodes_by_id[layoutNode.id];
            node.x = offsetX + (layoutNode.x * scale);
            node.y = offsetY + (layoutNode.y * scale);
        });

        return layout.links.map((link) => ({
            source: graphData.nodes_by_id[link.source_id],
            target: graphData.nodes_by_id[link.target_id],
            points: link.points.map((point) => ({
                x: offsetX + (point.x * scale),
                y: offsetY + (point.y * scale),
            })),
        }));
    }

    /**
     * Build a curved edge path whose visible endpoints land on node borders.
     */
    versionMapPath(link) {
        let start = GraphUtils.edgeEndpoint(link.source, link.target, 0);
        let end = GraphUtils.edgeEndpoint(link.target, link.source, 0);
        let points = link.points.slice();

        if (points.length === 0) {
            points = [start, end];
        } else {
            points[0] = start;
            points[points.length - 1] = end;
        }

        return d3.line()
            .x((point) => point.x)
            .y((point) => point.y)
            .curve(d3.curveCatmullRom.alpha(0.5))(points);
    }

    /**
     * Scale the cached tangled-tree ranks into the current viewport.
     */
    applyTangledTreeLayout(graphData, dimensions) {
        let layout = this.buildTangledTreeLayout(graphData);
        let horizontalPadding = 72;
        let verticalPadding = 40;
        let hasMultipleDepths = layout.depth_count > 1;
        let hasMultipleRows = layout.row_count > 1;
        let depthSpan = Math.max(1, layout.depth_count - 1);
        let rowSpan = Math.max(1, layout.row_count - 1);
        let columnSpacing = Math.max(120, graphData.nodes.reduce((maxSpacing, node) => Math.max(maxSpacing, node.node_width + 56), 120));
        let contentWidth = Math.max(dimensions.width, (horizontalPadding * 2) + (depthSpan * columnSpacing));
        let usableWidth = Math.max(1, contentWidth - (horizontalPadding * 2));
        let rowSpacing = Math.max(34, graphData.nodes.reduce((maxSpacing, node) => Math.max(maxSpacing, node.node_height + 14), 34));
        let contentHeight = Math.max(dimensions.height, (verticalPadding * 2) + (rowSpan * rowSpacing));
        let usableHeight = Math.max(1, contentHeight - (verticalPadding * 2));

        layout.nodes.forEach((layoutNode) => {
            let node = graphData.nodes_by_id[layoutNode.id];
            node.x = horizontalPadding + (usableWidth * (hasMultipleDepths ? (layoutNode.x_rank / depthSpan) : 0.5));
            node.y = verticalPadding + (usableHeight * (hasMultipleRows ? (layoutNode.y_rank / rowSpan) : 0.5));
        });

        let bundleSpacing = 10;
        let centerOffset = ((layout.max_bundle_count - 1) * bundleSpacing) / 2;

        return {
            content_width: contentWidth,
            content_height: contentHeight,
            links: layout.links.map((link) => ({
                source: graphData.nodes_by_id[link.source_id],
                target: graphData.nodes_by_id[link.target_id],
                rank: link.rank,
                bundle_offset: (link.bundle_offset_rank * bundleSpacing) - centerOffset,
            })),
        };
    }

    /**
     * Route tangled-tree links through a shared horizontal lane to emphasize overlap and divergence.
     */
    tangledTreePath(link) {
        let inset = 2;
        let start = {
            x: link.source.x + ((link.target.x >= link.source.x) ? ((link.source.node_width / 2) - inset) : (-(link.source.node_width / 2) + inset)),
            y: link.source.y,
        };
        let end = {
            x: link.target.x + ((link.source.x >= link.target.x) ? ((link.target.node_width / 2) - inset) : (-(link.target.node_width / 2) + inset)),
            y: link.target.y,
        };
        let dx = end.x - start.x;
        let maxMidOffset = Math.min(16, Math.abs(dx) * 0.12);
        let midOffset = Math.max(-maxMidOffset, Math.min(maxMidOffset, link.bundle_offset * 0.2));
        let midX = start.x + (dx * 0.5) + midOffset;
        midX = Math.max(Math.min(start.x, end.x) + 10, Math.min(Math.max(start.x, end.x) - 10, midX));
        let cornerRadius = Math.min(8, Math.max(4, Math.abs(dx) * 0.04));
        let horizontalSign = dx >= 0 ? 1 : -1;
        let startTurnX = midX - (horizontalSign * cornerRadius);
        let endTurnX = midX + (horizontalSign * cornerRadius);

        if (Math.abs(dx) < (cornerRadius * 6) || Math.abs(end.y - start.y) < 6) {
            return [
                "M", start.x, start.y,
                "L", end.x, end.y,
            ].join(" ");
        }

        return [
            "M", start.x, start.y,
            "L", startTurnX, start.y,
            "Q", midX, start.y, midX, start.y + ((end.y - start.y) >= 0 ? cornerRadius : -cornerRadius),
            "L", midX, end.y - ((end.y - start.y) >= 0 ? cornerRadius : -cornerRadius),
            "Q", midX, end.y, endTurnX, end.y,
            "L", end.x, end.y,
        ].join(" ");
    }

    /**
     * Render the layered DAG view once layout coordinates have been computed.
     */
    renderVersionMap(graphData) {
        this.stopGraph();
        this.setIndeterminateProgress("Computing layered version map. This can take a while for large streams.");

        this.buildSugiyamaLayoutAsync(graphData)
            .then(() => {
                if (this.activeView !== "version-map" || this.currentGraphData !== graphData) {
                    return;
                }

                let dimensions = this.graphDimensions();
                let dagLinks = this.applySugiyamaLayout(graphData, dimensions);
                let canvas = this.initializeGraphSvg(dimensions);
                let root = canvas.root;

                let link = root.append("g")
                    .attr("fill", "none")
                    .attr("stroke-linecap", "round")
                    .selectAll("path")
                    .data(dagLinks)
                    .join("path")
                    .attr("stroke", "#DDDDDD")
                    .attr("stroke-width", 1.4)
                    .attr("marker-end", "url(#arrowhead)");

                let nodeParts = this.createGraphNodes(root, graphData, null);

                this.graphState = {
                    svg: canvas.svg,
                    simulation: null,
                    view_type: "version-map",
                    node: nodeParts.node,
                    node_shape: nodeParts.node_shape,
                    node_text: nodeParts.node_text,
                    link: link,
                    nodes_by_id: graphData.nodes_by_id,
                    related_node_ids: graphData.related_node_ids,
                    selected_node_id: this.currentSelectedNodeId,
                    progress_enabled: false,
                    render_pending: false,
                    loading_dismissed: false,
                    render_now: () => {
                        this.graphState.link.attr("d", (d) => this.versionMapPath(d));
                        this.graphState.node
                            .attr("transform", (d) => "translate(" + d.x + "," + d.y + ")");
                    },
                    resizeHandler: () => {
                        this.renderCurrentGraph();
                    }
                };

                window.addEventListener("resize", this.graphState.resizeHandler);
                this.renderGraphNow();
                this.setProgress(1);
                this.updateSelection();
            })
            .catch((error) => {
                if (this.activeView !== "version-map" || this.currentGraphData !== graphData) {
                    return;
                }

                this.failure("Failed to render version map: " + error.message);
                this.setProgress(1);
            });
    }

    /**
     * Render a compact bundled layout that surfaces branching and convergence.
     */
    renderTangledTree(graphData) {
        this.stopGraph();
        this.setIndeterminateProgress("Building tangled tree layout.");
        this.setGraphScrollMode(true);

        let dimensions = this.graphDimensions();
        let tangledLayout = this.applyTangledTreeLayout(graphData, dimensions);
        let canvas = this.initializeGraphSvg({
            width: tangledLayout.content_width,
            height: tangledLayout.content_height,
        }, {
            stretchToContainer: false,
        });
        let root = canvas.root;

        let link = root.append("g")
            .attr("fill", "none")
            .attr("stroke-linecap", "round")
            .selectAll("path")
            .data(tangledLayout.links)
            .join("path")
            .attr("stroke", "#DDDDDD")
            .attr("stroke-width", 1.6)
            .attr("marker-end", "url(#arrowhead)");

        let nodeParts = this.createGraphNodes(root, graphData, null);

        this.graphState = {
            svg: canvas.svg,
            simulation: null,
            view_type: "tangled-tree",
            node: nodeParts.node,
            node_shape: nodeParts.node_shape,
            node_text: nodeParts.node_text,
            link: link,
            nodes_by_id: graphData.nodes_by_id,
            related_node_ids: graphData.related_node_ids,
            selected_node_id: this.currentSelectedNodeId,
            progress_enabled: false,
            render_pending: false,
            loading_dismissed: false,
            render_now: () => {
                this.graphState.link.attr("d", (d) => this.tangledTreePath(d));
                this.graphState.node
                    .attr("transform", (d) => "translate(" + d.x + "," + d.y + ")");
            },
            resizeHandler: () => {
                this.renderCurrentGraph();
            }
        };

        window.addEventListener("resize", this.graphState.resizeHandler);
        this.renderGraphNow();
        this.setProgress(1);
        this.updateSelection();
    }

    /**
     * Populate the stream selector, grouping by prefix and sorting within each group.
     */
    setStreams(streams) {
        let preselected = window.location.hash;
        if (!preselected) {
            preselected = this.defaultStream;
        } else {
            preselected = preselected.substring(1);
        }

        let select = $("#streams");
        select.empty();
        let groups = new Map();
        let streamsByGroup = new Map();

        streams.forEach((stream) => {
            let match = /^([^-]+)-/.exec(stream);
            let groupName = match ? match[1] : "other";

            if (!groups.has(groupName)) {
                groups.set(groupName, $("<optgroup></optgroup>").attr("label", groupName));
                streamsByGroup.set(groupName, []);
            }
            streamsByGroup.get(groupName).push(stream);
        });

        Array.from(groups.keys()).sort().forEach((groupName) => {
            streamsByGroup.get(groupName)
                .sort(GraphUtils.compareStreamNames)
                .forEach((stream) => {
                    let option = $("<option></option>")
                        .attr("value", stream)
                        .text(stream);

                    if (preselected === stream) {
                        option.prop("selected", true);
                        this.load(stream);
                    }

                    groups.get(groupName).append(option);
                });
            select.append(groups.get(groupName));
        });
    }

    /**
     * Fetch the stream index and then let setStreams choose the initial selection.
     */
    updateStreams() {
        $.ajax({
            url: "streams.json",
            type: "GET"
        })
            .done((data) => {
                this.setStreams(data);
            })
            .fail((r, e, ex) => {
                this.failure("Failed to refresh streams: " + ex);
            });
    }

    /**
     * Render the fallback channel overview shown when no specific node is selected.
     */
    setChannelOverview(target) {
        target.empty();
        if (this.networkMostRecent) {
            target.append($("<h5>Most Recent</h5>"));
            target.append($("<span>" + this.networkMostRecent.version + "</span>"));
        }
    }

    /**
     * Render either the channel summary or the selected node details into the side panel.
     */
    setInfo(type, value, from, to, errata) {
        if (type === undefined || type === null || type === "") {
            $("#info").show();
            $("#info-type").text("Channel");
            $("#info-value").text(this.currentChannel);
            $("#info-version-from-section").hide();
            $("#info-version-to-section").hide();
            $("#info-download-links-section").hide();
            $("#errata-link-section").hide();

            let overview = $("#info-overview");
            this.setChannelOverview(overview);
            overview.show();
            return;
        }

        $("#info").show();
        $("#info-type").text(type);
        $("#info-value").text(value);
        $("#info-overview").hide();

        if (value !== undefined && value.length > 0) {
            let downloads = $("#info-download-links");
            downloads.empty();
            downloads.append($("<li><a href=" + this.openshiftCliPubMirror + value + "/openshift-client-linux.tar.gz>oc (Linux x86_64)</a></li>"));
            downloads.append($("<li><a href=" + this.openshiftCliPubMirror + value + "/openshift-client-mac.tar.gz>oc (Mac)</a></li>"));
            downloads.append($("<li><a href=" + this.openshiftCliPubMirror + value + "/openshift-client-windows.zip>oc (Windows)</a></li>"));
            downloads.append($("<li><a href=" + this.openshiftCliPubMirror + value + "/openshift-install-linux.tar.gz>openshift-install (Linux x86_64)</a></li>"));
            downloads.append($("<li><a href=" + this.openshiftCliPubMirror + value + "/openshift-install-mac.tar.gz>openshift-install (Mac)</a></li>"));
            $("#info-download-links-section").show();
        } else {
            $("#info-download-links-section").hide();
        }

        if (from !== undefined && from.length > 0) {
            let fromList = $("#info-version-from");
            fromList.empty();
            from.forEach((entry) => {
                fromList.append($("<li></li>").text(entry));
            });
            $("#info-version-from-section").show();
        } else {
            $("#info-version-from-section").hide();
        }

        if (to !== undefined && to.length > 0) {
            let toList = $("#info-version-to");
            toList.empty();
            to.forEach((entry) => {
                toList.append($("<li></li>").text(entry));
            });
            $("#info-version-to-section").show();
        } else {
            $("#info-version-to-section").hide();
        }

        if (errata !== undefined && errata !== null && errata !== "") {
            $("#errata-link").attr("href", errata);
            $("#errata-link-section").show();
        } else {
            $("#errata-link-section").hide();
        }
    }

    /**
     * Update the shared loading overlay used by both render modes.
     */
    setProgress(progress) {
        if (this.graphState && this.graphState.loading_dismissed) {
            return;
        }

        console.debug("progress", progress);
        if (progress >= 1) {
            $("#graph-loading").hide();
            $("#graph-loading-text").text("");
            $("#graph-loading-progress").hide();
            $("#graph-loading-progress-bar")
                .width("0%")
                .text("")
                .removeClass("progress-bar-striped progress-bar-animated");
            return;
        }

        const value = Math.ceil(progress * 100);
        $("#graph-loading-text").text("Laying out graph.");
        $("#graph-loading-progress").css("display", "flex");
        $("#graph-loading-progress").attr("aria-valuenow", value.toString());
        $("#graph-loading-progress-bar")
            .width(`${value}%`)
            .text("")
            .removeClass("progress-bar-striped progress-bar-animated");
        $("#graph-loading").css("display", "flex");
    }

    setIndeterminateProgress(message) {
        if (this.graphState && this.graphState.loading_dismissed) {
            return;
        }

        $("#graph-loading-text").text(message);
        $("#graph-loading-progress").hide();
        $("#graph-loading-progress-bar")
            .width("0%")
            .text("")
            .addClass("progress-bar-striped progress-bar-animated");
        $("#graph-loading").css("display", "flex");
    }

    /**
     * Hide the loading UI permanently for the current render once the user interacts.
     */
    dismissGraphLoading() {
        if (this.graphState) {
            this.graphState.loading_dismissed = true;
        }

        $("#graph-loading").hide();
        $("#graph-loading-text").text("");
        $("#graph-loading-progress").hide();
        $("#graph-loading-progress-bar")
            .width("0%")
            .text("")
            .removeClass("progress-bar-striped progress-bar-animated");
    }

    /**
     * Reset view state, update the URL, and fetch the dataset for the selected stream.
     */
    load(stream) {
        this.stopGraph();
        this.cancelVersionMapWork();
        this.currentGraphData = null;
        this.currentSelectedNodeId = null;
        this.networkMostRecent = null;

        window.location.hash = "#" + stream;

        this.setProgress(0);

        this.currentChannel = stream;
        this.currentStreamVersion = GraphUtils.streamVersion(stream);
        $("#heading-channel").text(" – " + stream);

        this.setInfo();

        $.ajax({
            url: "streams/" + stream + ".json",
            accepts: {
                json: "application/json",
            },
            type: "GET",
            dataType: "json",
        })
            .done((data) => {
                try {
                    this.currentGraphData = this.buildGraphData(data);
                    this.networkMostRecent = this.currentGraphData.most_recent;
                    this.renderCurrentGraph();
                } catch (e) {
                    this.failure("Failed to process result: " + e);
                }
            })
            .fail((r, e, ex) => {
                this.failure("Failed to update graph: " + ex);
                this.setProgress(1);
            });
    }
}

window.OpenShiftUpdateGraphApp = OpenShiftUpdateGraphApp;
