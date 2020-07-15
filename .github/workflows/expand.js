
const fs = require('fs');
const data = fs.readFileSync(0, 'utf-8');

const channel = JSON.parse(data)

let result = [];

channel.edges.forEach(function(edge){
    let from = channel.nodes[edge[0]];
    let to = channel.nodes[edge[0]];
    result.push({
        from: from.version,
        to: to.version,
    });
});

result.sort((a,b) => {
    let c = a.from.localeCompare(b.from);
    if (c !== 0) {
        return c;
    } else {
        return a.to.localeCompare(b.to);
    }
});

process.stdout.write(JSON.stringify(result))
