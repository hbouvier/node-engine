var winston = require('winston'),
    config = {
        transports : [
                new (winston.transports.Console)({
                                                    "level"    : "debug",
                                                    "json"     : false,
                                                    "colorize" : true
                }),
                new (winston.transports.File)({
                                                    "filename" : "test.log",
                                                    "level"    : "debug",
                                                    "json"     : true,
                                                    "colorize" : false
                })
            ]
    },
    engine = require('../lib/engine'),
    script = __dirname + '/test-app',
    opts   = {
        "workers" : 8,
        "port"    : 3000,
    },
    server = engine(config);

server.start(script, opts).then(function () {
    console.log('*************** server started successfully! ***************');
});
