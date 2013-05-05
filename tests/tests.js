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
        "workers" : 1,
        "port"    : 3000,
        "watch"   : true
    },
    server = engine(config);

server.start(script, opts).then(function () {
    console.log('*************** server started successfully! ***************');
    setTimeout(function () {
        server.shutdown().done(function () {
            console.log('*************** server shutdown successfully! ***************');
            process.exit(0);
        })

    }, 3000);
}).fail(function () {
        console.log('Yikes');
        process.exit(-1);
    }).done(function () {

    });
