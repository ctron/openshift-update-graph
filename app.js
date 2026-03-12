// Stateless helpers shared by both graph views.
class GraphUtils {
    // Compare dotted numeric versions without needing full semver parsing.
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

    // Check whether a release belongs to the current major/minor stream.
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

    // Convert the stream identifier into the major/minor pair used for filtering.
    static streamVersion(streamId) {
        let s = /.*-([0-9]+)\.([0-9]+)/.exec(streamId);
        if (s) {
            return { major: s[1], minor: s[2] };
        }

        return null;
    }

    // Order stream ids by parsed major/minor version before falling back to the raw name.
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

    // Project an edge onto the border of the rounded node box instead of its center.
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

    // Approximate how far the force simulation has progressed toward its resting state.
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

// Coordinates data loading, UI state, and graph rendering for the page.
class OpenShiftUpdateGraphApp {
    constructor(options) {
        this.defaultStream = options.defaultStream;
        this.openshiftCliPubMirror = options.openshiftCliPubMirror;
        this.graphState = null;
        this.currentGraphData = null;
        this.currentSelectedNodeId = null;
        this.activeView = "force";
        this.textMeasureContext = null;
        this.versionMapWorker = null;
        this.versionMapRequestId = 0;
        this.networkMostRecent = null;
        this.currentChannel = null;
        this.currentStreamVersion = null;
    }

    init() {
        // Wire static page controls to the controller instance once on startup.
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

    graphDimensions() {
        // Measure the current graph container so both views can fill the available panel.
        let container = document.getElementById("graph");
        let rect = container.getBoundingClientRect();
        return {
            width: Math.max(rect.width, 320),
            height: Math.max(rect.height, 320),
        };
    }

    stopGraph() {
        // Tear down the active view before switching streams or render modes.
        if (this.graphState && this.graphState.simulation) {
            this.graphState.simulation.stop();
        }
        if (this.graphState && this.graphState.resizeHandler) {
            window.removeEventListener("resize", this.graphState.resizeHandler);
        }
        this.graphState = null;
        d3.select("#graph").selectAll("*").remove();
    }

    ensureVersionMapWorker() {
        // Lazily create the worker so the classic view does not pay for it up front.
        if (this.versionMapWorker || typeof Worker === "undefined") {
            return this.versionMapWorker;
        }

        this.versionMapWorker = new Worker("version-map-worker.js");
        return this.versionMapWorker;
    }

    cancelVersionMapWork() {
        // Bump the request id so late worker responses can be ignored safely.
        this.versionMapRequestId += 1;

        if (this.versionMapWorker) {
            this.versionMapWorker.terminate();
            this.versionMapWorker = null;
        }
    }

    setActiveView(view) {
        // Switching away from the layered view should abandon any in-flight layout work.
        if (this.activeView === "version-map" && view !== "version-map") {
            this.cancelVersionMapWork();
            this.setProgress(1);
        }

        this.activeView = view;

        $("#graph-tabs .nav-link").removeClass("active");
        $("#graph-tabs .nav-link[data-view='" + view + "']").addClass("active");

        this.renderCurrentGraph();
    }

    renderCurrentGraph() {
        // Re-render the current dataset using whichever view is active.
        if (!this.currentGraphData) {
            return;
        }

        if (this.activeView === "version-map") {
            this.renderVersionMap(this.currentGraphData);
            return;
        }

        this.renderForceGraph(this.currentGraphData);
        if (this.graphState) {
            this.graphState.selected_node_id = this.currentSelectedNodeId;
        }
        this.updateSelection();
    }

    scheduleGraphRender() {
        if (!this.graphState || this.graphState.render_pending) {
            return;
        }

        // Coalesce simulation ticks into a single DOM update per frame.
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

    estimateTextWidth(text) {
        if (this.textMeasureContext === null) {
            // Reuse one canvas context so node sizing stays cheap.
            let canvas = document.createElement("canvas");
            this.textMeasureContext = canvas.getContext("2d");
            this.textMeasureContext.font = "11px sans-serif";
        }

        return this.textMeasureContext.measureText(text).width;
    }

    ensureNodeMetrics(graphData) {
        // Cache text-derived node sizes once so both renderers can reuse them.
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

    updateGraphStyles() {
        // Keep the same highlighting rules across both views when selection changes.
        if (!this.graphState) {
            return;
        }

        let selectedId = this.graphState.selected_node_id;
        let related = selectedId ? this.graphState.related_node_ids[selectedId] : null;

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

        this.graphState.node_shape
            .attr("fill", (d) => GraphUtils.nodeFill(d))
            .attr("stroke", (d) => {
                if (d.id === selectedId) {
                    return "#222222";
                }
                if (related && related.has(d.id)) {
                    return "#5a5a5a";
                }
                return "#BBBBBB";
            })
            .attr("stroke-width", (d) => (d.id === selectedId ? 2.5 : 1.2))
            .attr("opacity", (d) => {
                if (!selectedId) {
                    return 1;
                }
                if (d.id === selectedId || related.has(d.id)) {
                    return 1;
                }
                return 0.3;
            });

        this.graphState.node_text
            .attr("opacity", (d) => {
                if (!selectedId) {
                    return d.is_most_recent ? 1 : 0.75;
                }
                if (d.id === selectedId || related.has(d.id)) {
                    return 1;
                }
                return 0.2;
            })
            .attr("fill", (d) => (d.id === selectedId ? "#111111" : "#404040"))
            .attr("font-weight", (d) => (d.id === selectedId || d.is_most_recent ? "600" : "400"));
    }

    updateSelection() {
        // The side panel is driven entirely from the currently selected graph node.
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

    selectNode(nodeId) {
        // Persist the selection so it survives a re-render or a view switch.
        this.currentSelectedNodeId = nodeId;

        if (!this.graphState) {
            return;
        }

        this.graphState.selected_node_id = nodeId;
        this.updateSelection();
    }

    buildGraphData(data) {
        // Normalize the raw stream payload into the node/link shape both renderers expect.
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

    initializeGraphSvg(dimensions) {
        // Build a fresh SVG root with zooming and a reusable arrowhead marker definition.
        let svg = d3.select("#graph")
            .append("svg")
            .attr("viewBox", "0 0 " + dimensions.width + " " + dimensions.height)
            .attr("width", dimensions.width)
            .attr("height", dimensions.height)
            .style("width", "100%")
            .style("height", "100%")
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

    createGraphNodes(root, graphData, dragBehavior) {
        // Render shared node visuals once so the two views only differ in edge/layout logic.
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

    renderForceGraph(graphData) {
        // The force layout is animated, so it maintains a live simulation state.
        this.stopGraph();
        this.setProgress(0);

        let dimensions = this.graphDimensions();
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
            .velocityDecay(0.45);

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

    buildSugiyamaLayout(graphData) {
        // Compute and cache layered coordinates in graphData for reuse across resizes.
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
            .nodeSize((node) => [node.data.node.node_height + 32, node.data.node.node_width + 56]);

        let layoutSize = layout(dag);
        graphData.version_map_layout = {
            width: layoutSize.height,
            height: layoutSize.width,
            nodes: Array.from(dag.nodes()).map((dagNode) => ({
                id: dagNode.data.node.id,
                x: dagNode.y,
                y: dagNode.x,
            })),
            links: Array.from(dag.links()).map((link) => ({
                source_id: link.source.data.node.id,
                target_id: link.target.data.node.id,
                points: link.points.map((point) => ({
                    x: point.y,
                    y: point.x,
                })),
            })),
        };

        return graphData.version_map_layout;
    }

    buildSugiyamaLayoutAsync(graphData) {
        if (graphData.version_map_layout) {
            return Promise.resolve(graphData.version_map_layout);
        }

        this.ensureNodeMetrics(graphData);

        let worker = this.ensureVersionMapWorker();
        if (!worker) {
            return Promise.resolve(this.buildSugiyamaLayout(graphData));
        }

        // Offload layered layout calculation to a worker for large streams.
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

    applySugiyamaLayout(graphData, dimensions) {
        // Scale cached layout coordinates into the current viewport with fixed padding.
        let layout = this.buildSugiyamaLayout(graphData);
        let horizontalPadding = 64;
        let verticalPadding = 48;
        let widthScale = layout.width > 0 ? Math.max(1, (dimensions.width - (horizontalPadding * 2)) / layout.width) : 1;
        let heightScale = layout.height > 0 ? Math.max(1, (dimensions.height - (verticalPadding * 2)) / layout.height) : 1;

        layout.nodes.forEach((layoutNode) => {
            let node = graphData.nodes_by_id[layoutNode.id];
            node.x = horizontalPadding + (layoutNode.x * widthScale);
            node.y = verticalPadding + (layoutNode.y * heightScale);
        });

        return layout.links.map((link) => ({
            source: graphData.nodes_by_id[link.source_id],
            target: graphData.nodes_by_id[link.target_id],
            points: link.points.map((point) => ({
                x: horizontalPadding + (point.x * widthScale),
                y: verticalPadding + (point.y * heightScale),
            })),
        }));
    }

    versionMapPath(link) {
        // Replace the first/last spline points so paths end on node borders, not centers.
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

    renderVersionMap(graphData) {
        // The layered DAG view is static once the layout coordinates are computed.
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

    setStreams(streams) {
        // Group streams by prefix so the selector stays navigable as the list grows.
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

    updateStreams() {
        // Fetch the stream index first, then let setStreams decide the initial selection.
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

    setChannelOverview(target) {
        // The channel overview is the fallback panel state when no specific node is selected.
        target.empty();
        if (this.networkMostRecent) {
            target.append($("<h5>Most Recent</h5>"));
            target.append($("<span>" + this.networkMostRecent.version + "</span>"));
        }
    }

    setInfo(type, value, from, to, errata) {
        // Render either the channel summary or the selected node details into the side panel.
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

    setProgress(progress) {
        // The loading overlay is shared by both render modes, including worker-backed layout.
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

    dismissGraphLoading() {
        // Once the user interacts with the graph, stop surfacing loading UI for that render.
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

    load(stream) {
        // Loading a stream resets view state, updates the URL, then fetches the new dataset.
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
