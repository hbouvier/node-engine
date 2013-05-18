var engine = require('node-engine'),
    server = engine({
        "script"       : "./MyHttpServer.js"
    });
if (server) {
    server.then(function () {
        console.log('server started');
    }).fail(function (reason) {
        console.log('server fail: ', reason);
        process.exit(-1);
    });
} else {
    console.log('worker started');
}
