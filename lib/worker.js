module.exports   = function (config) {
    var cluster  = require('cluster'),
        Q        = require('q'),
        /*winston  = require('winston'),
        logger   = new (winston.Logger)({
            transports: (config && config.transports) ? config.transports :
            [
                new (winston.transports.Console)({
                                                    "level"    : "debug",
                                                    "json"     : false,
                                                    "colorize" : true
                }),
                new (winston.transports.File)({
                                                    "filename" : "worker.log",
                                                    "level"    : "debug",
                                                    "json"     : true,
                                                    "colorize" : false
                })
            ]                
        }),*/
        server   = null,
        logger   = config.logger ? config.logger : { "log" : function () {} },
        meta     = {
            "module"   : "worker",
            "pid"      : process.pid
        };

    function _start(script, args) {
        process.argv = args;
        return require(script);
    }
    
    function _workerSetup() {
        process.on('message', function (msg) {
            
            // Make sure it is a valid message
            if (msg && msg.origin && msg.origin === 'master' && msg.action) {
                
                // Check if it is the start message and that the server is not
                // already started.
                if (msg.action === 'start' && msg.script && !server) {
                    logger.log('debug', 'W|worker-id=%d|message|start|msg=%j', cluster.worker.id, msg, meta);
                    server = _start(msg.script, msg.scriptArgv ? msg.scriptArgv : []);
                    
                    // If it was a module, check if it as a 'start' function and
                    // call it
                    if (server && typeof(server.start) === 'function') {
                        logger.log('debug', 'W|worker-id=%d|message|start|invoking-method=start|args=%j', cluster.worker.id, msg.methodArgs, meta);
                        server.start.apply(server, [msg.methodArgs]);
                    }
                } else if (msg.action === 'stop' && server) {
                    // If it was a module, check if it as a 'stop' function and
                    // call it
                    if (server && typeof(server.stop) === 'function') {
                        logger.log('debug', 'W|worker-id=%d|message|stop|invoking-method=stop|args=%j', cluster.worker.id, msg.methodArgs, meta);
                        server.stop.apply(server, msg.methodArgs);
                    }
                } else {
                    logger.log('debug', 'W|worker-id=%d|message|UNKNOWN|msg=%j', cluster.worker.id, msg, meta);                    
                }
            } else {
                logger.log('debug', 'W|worker-id=%d|message|INVALID|msg=%j', cluster.worker.id, msg, meta);
            }
        });
    }
    
    _workerSetup();    
    return {
    };
};