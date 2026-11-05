const cp = require("child_process");
const cmd = "ls";
cp.exec(cmd, {}, function (err, stdout) {});
