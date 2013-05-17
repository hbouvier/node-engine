(function () {
    var fs       = require('fs'),
        os       = require('os'),
        opts     = require('node-options'),
        winston  = require('winston'),
        engine   = require('./engine'),
        logger   = null,
        config   = JSON.parse(fs.readFileSync('package.json')).configuration,
        meta     = { 
            "module" : "main",
            "pid"    : process.pid
        };


    function initLogger(opt) {
        var log   = new (winston.Logger)({
            transports: (opt && opt.transports) ? opt.transports :
            [
                new (winston.transports.Console)({
                                                    "level"    : opt.level || "info",
                                                    "json"     : false,
                                                    "colorize" : true
                }),
                new (winston.transports.File)({
                                                    "filename" : opt.logfile || "./log/main.log",
                                                    "level"    : opt.level || "info",
                                                    "json"     : true,
                                                    "colorize" : false
                })
            ]                
        });
        return log;
    }
    
    function start(server, retry) {
        var promise = server.start(config.script).then(function() {
            logger.log('debug', '%s|start|succeeded', config.name, meta);
        }).fail(function () {
            logger.log('debug', '%s|start|failed|trying to stop', config.name, meta);
            stop(server).then(function () {
                if (!retry) {
                    logger.log('debug', '%s|start|re-trying to start', config.name, meta);
                    return start(server, true);
                }
            }).fail(function () {
                logger.log('debug', '%s|start=failed|stop=failed|bailing out', config.name, meta);
            });
        });
        return promise;
    }
    
    function stop(server) {
        var promise = server.stop().then(function() {
            logger.log('debug', '%s|stop|succeeded', config.name, meta);
        }).fail(function () {
            logger.log('debug', '%s|stop|failed', config.name, meta);
        });
        return promise;
    }

    ////////////////////////////////////////////////////////////////////////////
    //
    // MAIN
    //
    var options = config;
    
    // To run on PAAS like Heroku or Cloud9, the server has to use the port from
    // the environment. Here we overwrite the configuration/command line option
    // with the Enviroment Variable "PORT", only if it is defined.
    options.port    = process.env.PORT    || options.port;
    options.workers = process.env.WORKERS || options.workers  || os.cpus().length;
    
    // The "options" parameter is an object read from the package.json file.
    // Every property of that object can be overwritten through the command
    // line argument (e.g. --"property"=newValue)
    var result = opts.parse(process.argv.slice(2), options);
    
    logger = initLogger(options);
    // If the user invoked us without specifying a phrase (e.g. using --phrase)
    // Let's print the USAGE
    if (!result.args) {
        logger.log('error', '%s|USAGE|[--workers=#] [--port=#] [--level={silly|debug|verbose|info|warn|error}] path/server_script.js', config.name, meta);
        process.exit(-1);
    }
    
    // If an argument was passed on the command line, but was not defined in
    // the "configuration" property of the package.json, lets print the USAGE.
    if (result.errors) {
        logger.log('error', '%s|Unknown arguments|"' + result.errors.join('", "') + '"', config.name, meta);
        logger.log('error', '%s|USAGE|[--workers=#] [--port=#] [--level={debug|info|warn|error}] path/server_script.js', config.name, meta);
        process.exit(-1);
    }
    
    var server = engine({
        "port"       : options.port,
        "workers"    : options.workers,
        "script"     : result.args[0],
        "scriptArgv" : result.end,
        "startTimeoutInMs"    : options.startTimeoutInMs    || 5000,
        "shutdownTimeoutInMs" : options.shutdownTimeoutInMs || 5000,
        "stopTimeoutInMs"     : options.stopTimeoutInMs     || 1000
    });
    if (server) {
        logger.log('info', '%s|starting %d worker%s', config.name, config.workers, (config.workers > 1 ? 's' : ''));
        start(server).then(function () {
            logger.log('info', '%s|Started', config.name);
        }).fail(function () {
            logger.log('info', '%s|Failed to start', config.name);
        });
    }
}).call();

