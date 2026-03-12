importScripts("https://unpkg.com/d3-dag@1.1.0");

self.onmessage = function(event) {
    let message = event.data;

    try {
        self.postMessage({
            requestId: message.requestId,
            progress: 0.1,
        });

        let dag_input = message.nodes.map(function(node) {
            return {
                id: node.id,
                parentIds: node.parentIds,
                nodeWidth: node.nodeWidth,
                nodeHeight: node.nodeHeight,
            };
        });

        self.postMessage({
            requestId: message.requestId,
            progress: 0.3,
        });

        let stratify = d3.graphStratify()
            .id(function(d) { return d.id; })
            .parentIds(function(d) { return d.parentIds; });

        let dag = stratify(dag_input);

        self.postMessage({
            requestId: message.requestId,
            progress: 0.5,
        });

        let layout = d3.sugiyama()
            .layering(d3.layeringLongestPath())
            .decross(d3.decrossTwoLayer())
            .coord(d3.coordGreedy())
            .nodeSize(function(node) {
                return [node.data.nodeWidth + 56, node.data.nodeHeight + 32];
            });

        let layout_size = layout(dag);

        self.postMessage({
            requestId: message.requestId,
            progress: 0.85,
        });

        self.postMessage({
            requestId: message.requestId,
            progress: 1,
            layout: {
                width: layout_size.width,
                height: layout_size.height,
                nodes: Array.from(dag.nodes()).map(function(dag_node) {
                    return {
                        id: dag_node.data.id,
                        x: dag_node.x,
                        y: dag_node.y,
                    };
                }),
                links: Array.from(dag.links()).map(function(link) {
                    return {
                        source_id: link.source.data.id,
                        target_id: link.target.data.id,
                        points: link.points.map(function(point) {
                            return {
                                x: point.x,
                                y: point.y,
                            };
                        }),
                    };
                }),
            },
        });
    } catch (error) {
        self.postMessage({
            requestId: message.requestId,
            error: error.message,
        });
    }
};
