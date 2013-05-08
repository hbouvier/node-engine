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
        "workers"          : require('os').cpus().length || 1,
        "port"             : process.env.PORT || 3000,
        "watch"            : true,
        "startTimeoutInMs" : 5000,
        "stopTimeoutInMs"  : 45000
    },
    server = engine(config);
opts.workers = (process.argv.length === 3 ? process.argv[2] : opts.workers);

server.start(script, opts).then(function () {
    console.log('*************** server started successfully! ***************');
    setTimeout(function () {
        server.shutdown().done(function () {
            console.log('*************** server shutdown successfully! ***************');
            process.exit(0);
        })

    }, 30000);
}).fail(function () {
        console.log('Yikes');
        process.exit(-1);
    }).done(function () {

    });
