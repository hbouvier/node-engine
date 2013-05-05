module.exports = function (config) {
    var cluster  = require('cluster'),
        fs       = require('fs'),
        Q        = require('q'),
        Queue    = require('./Queue').Queue,
        winston  = require('winston'),
        logger   = new (winston.Logger)({
            transports: (config && config.transports) ? config.transports :
            [
                new (winston.transports.Console)({
                                                    "level"    : "info",
                                                    "json"     : false,
                                                    "colorize" : true
                }),
                new (winston.transports.File)({
                                                    "filename" : "master.log",
                                                    "level"    : "warn",
                                                    "json"     : true,
                                                    "colorize" : false
                })
            ]                
        }),
        meta     = { 
            "module" : "master",
            "pid"    : process.pid
        },
        startOptions = null,
        states = {
            "stopped"      :  0,
            "starting"     :  1,
            "stopping"     :  2,
            "reloading"    :  3,
            "running"      :  4,
            "exiting"      :  5,
            "toString"     : function (state) {
                for (var stateName in states) {
                    if (states.hasOwnProperty(stateName) && states[stateName] === state)
                        return stateName;
                }
                return 'unknown(' + state + ')';
            }
        },
        state        = states.stopped;

    function start(script, options) {
        logger.log('debug', 'M|starting|nb-workers=' + options.workers, meta);
        var deferred = Q.defer();
        actionQueue.add({
            "action" : "start",
            "params" : {
                "script"   : script,
                "options"  : options,
                "deferred" : deferred
            }
        });
        return deferred.promise;
    }
    
    function shutdown() {
        logger.log('debug', 'M|shutdown|disconnecting|all-workers', meta);
        var deferred = Q.defer();
        actionQueue.add({
            "action" : "shutdown",
            "params" : {
                "deferred" : deferred
            }
        });
        return deferred.promise;
    }
    
    function stop() {
        logger.log('debug', 'M|stop|killing|all-workers', meta);
        var deferred = Q.defer();
        actionQueue.add({
            "action" : "stop",
            "params" : {
                "deferred" : deferred
            }
        });
        return deferred.promise;
    }
    
    function reload() {
        var deferred = Q.defer();
        actionQueue.add({
            "action" : "reload",
            "params" : {
                "deferred" : deferred
            }
        });
        return deferred.promise;
    }

    
    ////////////////////////////////////////////////////////////////////////////

    var startTimeoutInMs = 30000,
        actionQueue = new Queue('actionQueue', {
            "execute" : function (err, node, next) {
                var func = node.action + 'Action';
                return eval(func + '(node.params)');
            }
        }).on(['add','execute'], function (event, node) {
                process.nextTick(function () {
                    actionQueue.execute();
                })
        }),
        startQueue = new Queue('startQueue', {
            "search" : function (key, node) {
                return (node.id === key);
            }
        }),
        stopQueue = new Queue('stopQueue', {
            "search" : function (key, node) {
                return (node.id === key);
            }
        });

    function startAction(params) {
        logger.log('debug', 'M|startingAction|nb-workers=' + params.options.workers, meta);
        if (state !== states.stopped) {
            params.deferred.reject(new Error(JSON.stringify({
                "module"   : meta.module,
                "function" : "start",
                "code"     : 400,
                "error"    : "Bad Request",
                "message" : "Unable to start. Invalid state '" + states.toString(state) + "'. Expected 'stopped'"
            })));
            logger.log('debug', 'M|startingAction|nb-workers=' + params.options.workers + '|done', meta);
            return null;
        }
        state        = states.starting;
        startOptions = params.options;
        setupObservers();
        for (var i = 0 ; i < params.options.workers ; ++i) {
            startOneWorker(params);
        }
        if (params.options && params.options.watch) {
            if (typeof(params.options.watch) === 'boolean') {
                logger.log('debug', 'M|starting|watch=' + params.script + '.js', meta);
                fs.watch(params.script + '.js', {persistent: true, interval: 1}, reload);
            } else {
                for(var index = 0 ; index < params.options.watch.length ; ++index) {
                    logger.log('debug', 'M|starting|watch=' + params.options.watch[index], meta);
                    fs.watch(params.options.watch[index], {persistent: true, interval: 1}, reload);
                }
            }
        }
        logger.log('debug', 'M|startingAction|nb-workers=' + params.options.workers + '|done', meta);
        return null;
    }
        
    function shutdownAction(params) {
        if (state !== states.running) {
            params.deferred.reject(new Error(JSON.stringify({
                "module"   : meta.module,
                "function" : "shutdown",
                "code"     : 400,
                "error"    : "Bad Request",
                "message" : "Unable to shutdown. Invalid state '" + states.toString(state) + "'. Expected 'running'"
            })));
            return null;
        }
        state = states.stopping;
        eachWorker(function (worker) {
            logger.log('debug', 'M|worker-id=' + worker.id + '|shutdown', meta);
            stopQueue.add({
                "id"       : worker.id,
                "worker"   : worker,
                "state"    : "shutdown",
                "deferred" : params.deferred,
                "timeout"  : setTimeout((function (w, to) {
                    return function() {
                        workerError(w, to, 'shutdown', function (worker) {
                            logger.log('warn', 'M|worker-id=' + worker.id + '|shutdown|Killing it', meta);
                            worker.process.kill();
                        });
                    };
                })(worker, startTimeoutInMs), startTimeoutInMs)
            });
        });
        
        cluster.disconnect(function () {
            logger.log('debug', 'M|shutdown|disconnected|ALL-WORKERS-ARE-DEAD', meta);
            /*
            state = states.stopped;
            params.deferred.resolve({
                "id"     : params.worker.id,
                "worker" : params.worker,
                "state"  : "disconnected"
            });
            */
        });
        return null;
    }
    
    function stopAction(params) {
        if (state !== states.running && state !== states.exiting) {
            params.deferred.reject(new Error(JSON.stringify({
                "module"   : meta.module,
                "function" : "stop",
                "code"     : 400,
                "error"    : "Bad Request",
                "message" : "Unable to stop. Invalid state '" + states.toString(state) + "'. Expected 'running' or 'exiting'"
            })));
            return null;
        }
        state = states.stopping;
        eachWorker(function (worker) {
            logger.log('debug', 'M|worker-id=' + worker.id + '|SIGTERM|Killing', meta);
            stopQueue.add({
                "id"       : worker.id,
                "worker"   : worker,
                "state"    : "stopping",
                "deferred" : params.deferred,
                "timeout"  : setTimeout((function (w, to) {
                    return function() {
                        workerError(w, to, 'stopping', function (worker) {
                            logger.log('warn', 'M|worker-id=' + worker.id + '|SIGTERM|Killing it with SIGKILL', meta);
                            worker.process.kill('SIGKILL');
                        });
                    };
                })(worker, startTimeoutInMs), startTimeoutInMs)
            });
            worker.process.kill();
        });
        return null;
    }
    
    function reloadAction(deferred) {
        if (state !== states.running) {
            deferred.reject(new Error(JSON.stringify({
                "module"   : meta.module,
                "function" : "reload",
                "code"     : 400,
                "error"    : "Bad Request",
                "message" : "Unable to reload. Invalid state '" + states.toString(state) + "'. Expected 'running'"
            })));
            return null;
        }
        state = states.reloading;
        
        reloadIDs = [];
        for (var id in cluster.workers) {
            reloadIDs.push(id);
        }
        logger.log('debug', 'M|reload|------------------------------------------', meta);
        logger.log('debug', 'M|reload|workers=' + reloadIDs.join(', '), meta);
        restartOneWorker();
        return null;
    }
    

    ////////////////////////////////////////////////////////////////////////////
        
        
    var reloadIDs;

    function startOneWorker(params) {
        logger.log('debug', 'startOneWorker');
        var worker = cluster.fork();
        logger.log('debug', 'startOneWorker|id='+worker.id);
        startQueue.add({
            "state"    : "fork",
            "id"       : worker.id,
            "deferred" : params.deferred
        });
        worker.send({
            "id"      : worker.id,
            "origin"  : meta.module,
            "action"  : "start",
            "options" : startOptions
        });
    }
    
    
    
    function restartOneWorker() {
        if (reloadIDs && reloadIDs.length > 0) {
            var id = reloadIDs.shift();
            if (id) {
                logger.log('debug', 'M|worker-id=' + id + '|restartOneWorker|workers=' + reloadIDs.join(', '), meta);
                cluster.workers[id].disconnect();
            }
        }
    }
    
    function eachWorker(callback) {
        for (var id in cluster.workers) {
            callback(cluster.workers[id]);
        }
    }
    
    function kill(worker) {
        process.kill(worker.process.pid, 'SIGHUP');
    }

    function setupObservers() {
        cluster.on('fork', function(worker) {
            logger.log('debug', 'M|worker-id=' + worker.id + '|on=fork', meta);
            // -- We just forked this worker. We will setup a timer to kill
            //    this worker if it does not start listenning in a certain
            //    amount of time.
            startQueue.execute(worker.id, function (err, node, next) {
                node.state = 'forked';
                node.timeout = setTimeout((function (w, to) {
                    return function() {
                        workerError(w, to, 'start', function (worker) {
                            worker.process.kill();
                            return null;
                        });
                        node.deferred.reject(new Error(JSON.stringify({
                            "module"   : meta.module,
                            "function" : "timeout",
                            "code"     : 400,
                            "error"    : "Bad Request",
                            "message" : "Took too much time to start"
                        })));
                    };
                })(worker, startTimeoutInMs), startTimeoutInMs);
                return node;
            });
        });
        
        cluster.on('online', function(worker) {
            logger.log('debug', 'M|worker-id=' + worker.id + '|on=online', meta);
            startQueue.execute(worker.id, function (err, node, next) {
                node.state = 'onlined';
                return node;
            });
        });  

        cluster.on('listening', function(worker, address) {
            logger.log('debug', 'M|worker-id=' + worker.id + '|on=listening', meta);
            startQueue.execute(worker.id, function (err, node, next) {
                node.state = 'listening';
                clearTimeout(node.timeout);
                node.timeout = null;
                delete node.timeout;
                if (startQueue.isEmpty()) {
                    node.deferred.resolve({
                        "id"     : worker.id,
                        "worker" : worker,
                        "state"  : "started"
                    });
                    state = states.running;
                } else {
                    node.deferred = null;
                    delete node.deferred;
                }
                return null;
            });
            logger.log('debug', 'M|worker-id=' + worker.id + '|on=listening|address=' + address.address + ':' + address.port + '|is listening', meta);
        });
        
        cluster.on('disconnect', function(worker) {
            logger.log('debug', 'M|worker-id=' + worker.id + '|on=disconnect', meta);
            stopQueue.execute(worker.id, function (err, node, next) {
                node.state = 'disconnected';
                return node;
            });
        });        
        
        cluster.on('exit', function(worker, code, signal) {
            logger.log('debug', 'M|worker-id=' + worker.id + '|on=exit|code='+ code + '|signal=' + signal + (worker.suicide ? '|suicide' : ''), meta);
            stopQueue.execute(worker.id, function (err, node, next) {
                node.state = 'exited';
                clearTimeout(node.timeout);
                node.timeout = null;
                delete node.timeout;
                if (stopQueue.isEmpty()) {
                    node.deferred.resolve({
                        "id"     : worker.id,
                        "worker" : worker,
                        "state"  : "exited"
                    });
                    state = states.stopped;
                } else {
                    node.deferred = null;
                    delete node.deferred;
                }
                return null;
            });
        });
        
        // --- When the MASTER process is killed, lets kill all the worker threads
        //
        process.on('SIGTERM', function () {
            var exitCode = 0;
            state = states.exiting;
            logger.log('debug', 'M|SIGTERM|Killing all workers', meta);
            stop().then(function () {
                logger.log('info', 'M|SIGTERM|all workers dead', meta);
                process.nextTick(function() {
                    logger.log('info', 'M|SIGTERM|exiting|code=' + exitCode, meta);
                    process.exit(exitCode);
                });
            });
        });
    }
    
    function workerError(worker, timeoutInMs, state, next) {
        logger.log('debug', 'M|worker-id=' + worker.id + '|TIMEOUT|Took more than ' + (timeoutInMs /1000) + 'sec to ' + state, meta);
        if (typeof(next) === 'function') {
            return next(worker);
        }
        return null;
    }
    
    return {
        "start"      : start,
        "stop"       : stop,
        "shutdown"   : shutdown,
        "reload"     : reload
    };
};
