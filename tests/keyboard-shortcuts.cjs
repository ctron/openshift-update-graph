const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const context = { window: {} };
vm.runInNewContext(fs.readFileSync(require.resolve("../app.js"), "utf8"), context);
const app = new context.window.OpenShiftUpdateGraphApp({});

for (const [target, key, expected] of [
    [{ tagName: "SELECT" }, "/", true],
    [{ tagName: "BODY" }, "/", true],
    [{ tagName: "INPUT" }, "/", false],
    [{ tagName: "TEXTAREA" }, "/", false],
    [{ tagName: "DIV", isContentEditable: true }, "/", false],
    [{ tagName: "SELECT" }, "ArrowDown", false],
]) {
    let focused = false;
    let prevented = false;
    app.focusSearch = () => { focused = true; };
    app.handleGlobalKeydown({
        target,
        key,
        preventDefault() { prevented = true; },
    });
    assert.equal(focused, expected, `${target.tagName}: ${key} focus`);
    assert.equal(prevented, expected, `${target.tagName}: ${key} default`);
}
