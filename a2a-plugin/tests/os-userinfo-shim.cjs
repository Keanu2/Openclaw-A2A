const os = require("os");
os.userInfo = () => ({ username: "test", uid: 1000, gid: 1000, homedir: os.homedir(), shell: "" });
