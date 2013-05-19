// curl http://engine.beeker.c9.io/
var winston = require('winston'),
    config = {
        "logger" : new (winston.Logger)({transports: [
                new (winston.transports.Console)({
                                                    "level"    : "debug",
                                                    "json"     : false,
                                                    "colorize" : true
                })
            ]}),
        "workers"          : (process.argv.length === 3 ? process.argv[2] : (require('os').cpus().length || 1)),
        "startTimeoutInMs"    : 5000,
        "shutdownTimeoutInMs" : 5000,
        "stopTimeoutInMs"     : 1000,
        "script": __dirname + '/test-app',
        "scriptConfig" : {},
        "port"             : process.env.PORT || 3000
    },
    engine = require('../lib/engine'),
    server = engine(config);

if (server) {
server.start().then(function () {
    console.log('*************** server started successfully! ***************');

    setTimeout(function () {
        server.restart().then(function () {
            console.log('*************** server restarted successfully! ***************');
            setTimeout(function () {
                server.shutdown().then(function () {
                    console.log('*************** server shutdown successfully! ***************');
                    server.start(__dirname + '/test-app').then(function () {
                        console.log('*************** server started (2) successfully! ***************');
                        server.stop().then(function () {
                            console.log('*************** server STOPPED successfully! ***************');                        
                        }).fail(function() {
                            console.log('*************** server FAILED TO STOPPED! ***************');                        
                            process.exit(0);
                        }).done();
                    }).fail(function () {
                        console.log('*************** server FAILED TO START! ***************');                        
                        process.exit(0);
                    }).done();
                }).fail(function () {
                    console.log('*************** server FAILED to shutdown miserably! ***************');
                    process.exit(0);
                }).done();
            }, 5000);
        }).fail(function() {
            console.log('*************** server FAILED to restart miserably! ***************');
            process.exit(0);
        }).done();
    }, 10000);
}).fail(function () {
        console.log('*************** server startup FAILED miserably! ***************');
        console.log('Yikes');
        process.exit(-1);
    }).done(function () {
        console.log('********************* See ya next time ************************');
    });
}