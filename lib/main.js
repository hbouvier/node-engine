/**
 * node bin/engine --level=info --workers=1 tests/test-app.js -- -opt=1
 */
(function () {
    var fs       = require('fs'),
        os       = require('os'),
        Q        = require('q'),
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
        var log   = new (winston.Logger)({transports: [
                new (winston.transports.Console)({
                                                    "level"    : opt.level || "info",
                                                    "json"     : false,
                                                    "colorize" : true
                })
            ]});
        return log;
    }
    
    function start(server, deferred) {
        var shouldRetry = !deferred;
        if (!deferred) {
            deferred = Q.defer();
        }
        server.start().then(function() {
            logger.log('debug', '%s|start|succeeded', config.name, meta);
            deferred.resolve();
        }).fail(function () {
            logger.log('debug', '%s|start|failed|trying to stop', config.name, meta);
            stop(server).then(function () {
                if (shouldRetry) {
                    logger.log('debug', '%s|start|re-trying to start', config.name, meta);
                    return start(server, deferred);
                }
            }).fail(function () {
                logger.log('debug', '%s|start=failed|stop=failed|bailing out', config.name, meta);
            });
            deferred.reject(new Error(config.name + '|Unable to start'));
        });
        return deferred.promise;
    }
    
    function stop(server) {
        var promise = server.stop().then(function() {
            logger.log('debug', '%s|stop|succeeded', config.name, meta);
        }).fail(function () {
            logger.log('debug', '%s|stop|failed', config.name, meta);
        });
        return promise;
    }
    
    function watch(server, files) {
        var closure = function (event, filename) {
            restart(server, event, filename);
        };
        
        for (var i = 0 ; i < files.length ; ++i) {
            logger.log('debug', '%s|watching|file=%s', config.name, files[i], meta);
            fs.watch(files[i], {persistent: true, interval: 1}, closure);
        }
    }
    
    function restart(server, event, filename) {
        logger.log('debug', '%s|watch|event=%s|file=%s|restarting server', config.name, event, filename, meta);
        server.restart().then(function() {
            logger.log('verbose', '%s|watch|event=%s|file=%s|server restarted', config.name, event, filename, meta);
        }).fail(function () {
            logger.log('verbose', '%s|watch|event=%s|file=%s|FAILED|server unchanged.', config.name, event, filename, meta);            
        });
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
    var script = (result.args[0].substring(0, 1) === '/' ? result.args[0] : process.cwd() + '/' + result.args[0]);
    var server = engine({
        "workers"      : options.workers,
        "script"       : script,
        "scriptArgv"   : result.end,
        "scriptConfig" : {
            "port"         : options.port
        },
        "logger"       : logger,
        "startTimeoutInMs"    : options.startTimeoutInMs    || 5000,
        "shutdownTimeoutInMs" : options.shutdownTimeoutInMs || 5000,
        "stopTimeoutInMs"     : options.stopTimeoutInMs     || 1000
    });
    if (server) {
        logger.log('debug', '%s|starting %d worker%s', config.name, config.workers, (config.workers > 1 ? 's' : ''));
        start(server).then(function () {
            logger.log('verbose', '%s|started|workers=%d', config.name, config.workers);
            watch(server, result.args);
        }).fail(function (reason) {
            logger.log('error', '%s|FAILED|reason-%j', config.name, reason, meta);
            process.exit(-1);
        });
    }
}).call();

