# OpenShift Update Graph Visualizer

This is the source code for the [OpenShift update graph visualizer](https://ctron.github.io/openshift-update-graph).

[![Example](images/example.png "Example Screenshot")](https://ctron.github.io/openshift-update-graph)

## About

The data is fetched from the OpenShift update information endpoint (https://api.openshift.com/api/upgrades_info/v1/graph).
This data is being by [openshift/cincinnati](https://github.com/openshift/cincinnati), and contains the information
which version upgrades are possible.

As the endpoint doesn't set any CORS headers, the data is being synced very 15 minutes to this
repository. A check is added to see if the content of the graph changed, as the original content
is not sorted, the order of the nodes, and thus the "edge information" changes with every request.

At the same time, the list of possible channels is refreshed as well.   

## Credit

This solution is inspired by the `graph.sh` script, from [openshift/cincinnati](https://github.com/openshift/cincinnati/blob/master/hack/graph.sh),
which takes the upgrade information, and creates a `dot` file from it,
which can be visualized with the [Graphviz](https://graphviz.org/) `dot` tool.
 