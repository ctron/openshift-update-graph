
const fs = require('fs');
const data = fs.readFileSync(0, 'utf-8');

const channel = JSON.parse(data)

let result = {
    nodes: [],
    edges: []
};

channel.nodes.forEach(function(node){
    result.nodes.push(node.version);
})
result.nodes.sort((a,b) => a.localeCompare(b));

channel.edges.forEach(function(edge){
    let from = channel.nodes[edge[0]];
    let to = channel.nodes[edge[1]];
    result.edges.push({
        from: from.version,
        to: to.version,
    });
});

result.edges.sort((a,b) => {
    let c = a.from.localeCompare(b.from);
    if (c !== 0) {
        return c;
    } else {
        return a.to.localeCompare(b.to);
    }
});

process.stdout.write(JSON.stringify(result, null, "  "))
