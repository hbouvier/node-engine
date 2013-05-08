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
        savedOptions = null,
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

    /**
     * @public
     * 
     * Start an instance of the Engine
     * 
     * @param script   The actual server code.
     * @param options  Configuration for the server
     * 
     *            workers  Number of "threads" to run
     * 
     *            watch    true  -> reload when "script" file change on disk
     *                     Array -> reload when any file in the Array change on disk
     * 
     *            startTimeoutInMs If a worker does start "listening" in that amount
     *                             of MiliSeconds, it will be killed.
     *                            
     *            stopTimeoutInMs  If a worker does not shutdown/stop in that amount
     *                             of MiliSeconds, it will be killed.
     * 
     */
    function start(script, options) {
        logger.log('debug', 'M|starting|nb-workers=' + options.workers, meta);
        var deferred = Q.defer();  // resolved by the 'listening' event
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
    
    /**
     * @public
     * 
     * Shutdown nicely the engine. Start by 'stopping' answering to new connection
     *          and wait for the current Request to finish before 'exiting' the
     *          "thread" worker(s).
     */
    function shutdown() {
        logger.log('debug', 'M|shutdown|disconnecting|all-workers', meta);
        var deferred = Q.defer();  // resolved by the 'exit' event
        actionQueue.add({
            "action" : "shutdown",
            "params" : {
                "deferred" : deferred
            }
        });
        return deferred.promise;
    }
    
    /**
     * @public
     * 
     * Stop forcefully the engine. This will KILL all the workers without waiting
     *          for the current Request to finish.
     */
    function stop() {
        logger.log('debug', 'M|stop|killing|all-workers', meta);
        var deferred = Q.defer();  // resolved by the 'exit' event
        actionQueue.add({
            "action" : "stop",
            "params" : {
                "deferred" : deferred
            }
        });
        return deferred.promise;
    }
    
    /**
     * @public
     * 
     * Will cycle through all the workers, one by one making them stop answering
     * new connection and finishing processing the current Request, then terminating
     * it and starting a new worker, once that new worker is listening to new 
     * connection/request, then we do it all over again with the next worker until
     * all workers are restarted.
     */
    function reload() {
        var deferred = Q.defer();  // resolved by the 'listening' event
        actionQueue.add({
            "action" : "reload",
            "params" : {
                "deferred" : deferred
            }
        });
        return deferred.promise;
    }

    
    ////////////////////////////////////////////////////////////////////////////

    /**
     * The "actionQueue" is where the Public methods queue "start", "stop",
     * "shutdown", "reload" function calls to be executed, in sequence by
     * the Engine.
     */
    var actionQueue = new Queue('actionQueue', {
            /* Use the default SEARCH function
             * The EXECUTOR will "call" the Private function named
             * "function" + "Action".
             */
            "execute" : function (err, node, next) {
                var func = node.action + 'Action';
                var obj = eval(func + '(node.params)');
                logger.log('debug', "actionQueue::execute|obj="+obj);
                return null;
            }
        }).on(['add'], function (event, node) {
            /*
             * This is to have the "actionQueue" automatically call the "execute"
             * method as soon as a new action is added to it, then it should wait
             * for that action to be completed, promise resolved/rejected and only
             * then "execute" the next action in the queue.
             *
             * How are we gogin to do that? Lets assume that the queue starts 
             * empty, as soon as we add an element, we will invoke the
             * "executeNextTask" to create a deferred object and attach a function
             * to execute the next action *if* there is another action in the queue.
             *
             * When no other action in the queue, we do nothing and wait for the
             * next action to be ADDED to the queue at which point we will execute
             * it, etc..
             */
            var executeNextTask = function() {
                if (!actionQueue.deferred && actionQueue.isEmpty() === false) {
                    logger.log('debug', 'Queue::on|event=' + event + '|creating Promise');
                    actionQueue.deferred = Q.defer(); // resolved by the 'listening' or 'exit' event
                    actionQueue.deferred.promise.done(function () {
                        logger.log('debug', 'Queue::on|event=' + event + '|action='+node.action+'|Completed|nullifying Promise');
                        actionQueue.deferred = null;
                        executeNextTask();
                    });
                    process.nextTick(function () {
                        actionQueue.execute();
                    });
                }
            };
            executeNextTask();
        }),
        /* This queue is to keep the list of worker object we are working on
         * (e.g. starting, stopping or restarting them)/
         */
        workerQueue = new Queue('workerQueue', {
            "search" : function (key, node) {
                return (key === null || node.id === key);
            }
        });
        
    ////////////////////////////////////////////////////////////////////////////

    /**
     * @private
     * 
     * start the enging if the state is 'stopped'
     * 
     * @param params  an object containing:
     *           options  Configuration passed to the Public start() method
     *           deferred The Promise that we must resolve or reject
     */
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
        savedOptions = params.options;
        setupObservers();
        for (var i = 0 ; i < params.options.workers ; ++i) {
            startOneWorker(params);
        }
        if (params.options && params.options.watch) {
            if (typeof(params.options.watch) === 'boolean') {
                logger.log('debug', 'M|starting|watch=' + params.script + '.js', meta);
                fs.watch(params.script + '.js', {persistent: true, interval: 1}, fsReload);
            } else {
                for(var index = 0 ; index < params.options.watch.length ; ++index) {
                    logger.log('debug', 'M|starting|watch=' + params.options.watch[index], meta);
                    fs.watch(params.options.watch[index], {persistent: true, interval: 1}, fsReload);
                }
            }
        }
        logger.log('debug', 'M|startingAction|nb-workers=' + params.options.workers + '|done', meta);
        return null;
    }
        
    /**
     * @private
     * 
     * Shutdown gracefully the enging if the state is 'running'
     * 
     * @param params  an object containing:
     *           deferred The Promise that we must resolve or reject
     */
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
        logger.log('debug', '***** STATE ' +  states.toString(state) + ' --> ' + states.toString(states.stopping));
        state = states.stopping;
        eachWorker(function (worker) {
            logger.log('debug', 'M|worker-id=' + worker.id + '|shutdown', meta);
            workerQueue.add({
                "id"       : worker.id,
                "worker"   : worker,
                "state"    : "shutdown",
                "deferred" : params.deferred,
                "timeout"  : setTimeout((function (w, to) {
                    return function() {
                        workerError(w, to, 'shutdown', function (worker) {
                            logger.log('warn', 'M|worker-id=' + worker.id + '|shutdown|Killing it with SIGKILL', meta);
                            worker.process.kill('SIGKILL');
                        });
                    };
                })(worker, savedOptions.stopTimeoutInMs), savedOptions.stopTimeoutInMs)
            });
        });
        
        cluster.disconnect(function () {
            logger.log('debug', 'M|shutdown|disconnected|ALL-WORKERS-ARE-DEAD', meta);
        });
        return null;
    }
    
    /**
     * @private
     * 
     * Stop forcefully the enging if the state is 'running'
     * 
     * @param params  an object containing:
     *           deferred The Promise that we must resolve or reject
     */
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
        logger.log('debug', '***** STATE ' +  states.toString(state) + ' --> ' + states.toString(states.stopping));
        state = states.stopping;
        eachWorker(function (worker) {
            logger.log('debug', 'M|worker-id=' + worker.id + '|stop|Killing', meta);
            workerQueue.add({
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
                        // TODO: should we reject the Promise?!
                    };
                })(worker, savedOptions.stopTimeoutInMs), savedOptions.stopTimeoutInMs)
            });
            worker.process.kill();
        });
        return null;
    }
    
    /**
     * @private
     * 
     * Reload the server 'script' and restart all the worker 'threads'
     * 
     * @param params  an object containing:
     *           deferred The Promise that we must resolve or reject
     */
    function reloadAction(params) {
        if (state !== states.running) {
            params.deferred.reject(new Error(JSON.stringify({
                "module"   : meta.module,
                "function" : "reload",
                "code"     : 400,
                "error"    : "Bad Request",
                "message" : "Unable to reload. Invalid state '" + states.toString(state) + "'. Expected 'running'"
            })));
            return null;
        }
        logger.log('debug', '***** STATE ' +  states.toString(state) + ' --> ' + states.toString(states.reloading));
        state = states.reloading;
        eachWorker(function (worker) {
            logger.log('debug', 'M|worker-id=' + worker.id + '|restart', meta);
            workerQueue.add({
                "id"       : worker.id,
                "worker"   : worker,
                "state"    : "restarting",
                "deferred" : params.deferred,
                "timeout"  : setTimeout((function (w, to) {
                    return function() {
                        workerError(w, to, 'restarting', function (worker) {
                            logger.log('warn', 'M|worker-id=' + worker.id + '|reload|Killing it with SIGKILL', meta);
                            worker.process.kill('SIGKILL');
                        });
                        // TODO: should we reject the Promise?!
                    };
                })(worker, savedOptions.stopTimeoutInMs), savedOptions.stopTimeoutInMs)
            });
        });
        restartOneWorker();
        return null;
    }
    

    ////////////////////////////////////////////////////////////////////////////
        
        

    function startOneWorker(params) {
        logger.log('debug', 'startOneWorker');
        var worker = cluster.fork();
        logger.log('debug', 'startOneWorker|id='+worker.id);
        workerQueue.add({
            "state"    : "fork",
            "id"       : worker.id,
            "worker"   : worker,
            "deferred" : params.deferred
        });
        worker.send({
            "id"      : worker.id,
            "origin"  : meta.module,
            "action"  : "start",
            "options" : savedOptions,
            "server"  : {
                "start"      : start,
                "stop"       : stop,
                "shutdown"   : shutdown,
                "reload"     : reload
            }
        });
    }

    function restartOneWorker() {
        workerQueue.execute(function (err, node, next) {
            node.state = 'restarting-stopping';
            logger.log('debug', 'M|worker-id=' + node.id + '|restartOneWorker', meta);
            cluster.workers[node.id].disconnect();
            return node;
        });
    }

    function setupObservers() {
        
        /*
         * In case a worker does not start an http server, it can send a message
         * to stop the 'timer' that would kill this worker if it does not start
         * listening
         */
        process.on('message', function (msg) {
            if (msg.action === 'listening') {
                logger.log('debug', 'M|worker-id=' +  msg.id + '|message|started|options=' + JSON.stringify(msg.options), meta);
                wokerStarted(msg.id);
            } else  {
                logger.log('debug', 'M|message|UNKNOWN|message=' + JSON.stringify(msg), meta);
            }

        });

        cluster.on('fork', function(worker) {
            logger.log('debug', 'M|worker-id=' + worker.id + '|on=fork', meta);
            // -- We just forked this worker. We will setup a timer to kill
            //    this worker if it does not start listenning in a certain
            //    amount of time.
            workerQueue.execute(worker.id, function (err, node, next) {
                node.state = state === states.reloading ? 're-forked' : 'forked';
                node.timeout = setTimeout((function (w, to) {
                    return function() {
                        workerError(w, to, 'start', function (worker) {
                            worker.process.kill();
                            return null;
                        });
                        // TODO: should we try to restart it instead?!
                        node.deferred.reject(new Error(JSON.stringify({
                            "module"   : meta.module,
                            "function" : "timeout",
                            "code"     : 400,
                            "error"    : "Bad Request",
                            "message" : "Took too much time to start"
                        })));
                    };
                })(worker, savedOptions.startTimeoutInMs), savedOptions.startTimeoutInMs);
                return node;
            });
        });
        
        cluster.on('online', function(worker) {
            logger.log('debug', 'M|worker-id=' + worker.id + '|on=online', meta);
            workerQueue.execute(worker.id, function (err, node, next) {
                node.state = state === states.reloading ? 're-onlined' : 'onlined';
                return node;
            });
        });  

        cluster.on('listening', function(worker, address) {
            logger.log('debug', 'M|worker-id=' + worker.id + '|on=listening', meta);
            wokerStarted(worker.id);
            logger.log('debug', 'M|worker-id=' + worker.id + '|on=listening|address=' + address.address + ':' + address.port + '|is listening', meta);
        });
        
        cluster.on('disconnect', function(worker) {
            logger.log('debug', 'M|worker-id=' + worker.id + '|on=disconnect', meta);
            workerQueue.execute(worker.id, function (err, node, next) {
                node.state = state === states.reloading ? 're-disconnected' : 'disconnected';
                return node;
            });
        });
        
        cluster.on('exit', function(worker, code, signal) {
            logger.log('debug', 'M|worker-id=' + worker.id + '|on=exit|code='+ code + '|signal=' + signal + (worker.suicide ? '|suicide' : ''), meta);
            workerQueue.execute(worker.id, function (err, node, next) {
                node.state = state === states.reloading ? 're-exited' : 'exited';
                clearTimeout(node.timeout);
                node.timeout = null;
                delete node.timeout;
                if (state === states.reloading) {
                    startOneWorker({
                        "deferred" : node.deferred
                    });
                } else {
                    if (workerQueue.isEmpty()) {
                        node.deferred.resolve({
                            "id"     : worker.id,
                            "worker" : worker,
                            "state"  : "exited"
                        });
                        logger.log('debug', '***** STATE ' +  states.toString(state) + ' --> ' + states.toString(states.stopping));
                        state = states.stopped;
                        process.nextTick(function () {
                            actionQueue.deferred.resolve({
                                "id"     : node.id,
                                "worker" : node.worker,
                                "state"  : "exiting",
                                "action" : "stopped"
                            });
                        });
                    }
                }
                return null;
            });
        });
        
        // --- When the MASTER process is killed, lets kill all the worker threads
        //
        process.on('SIGTERM', function () {
            var exitCode = 0;
            logger.log('debug', '***** STATE ' +  states.toString(state) + ' --> ' + states.toString(states.exiting));
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

    ///////////////////////////////////////////////////////////////////////////

    function eachWorker(callback) {
        for (var id in cluster.workers) {
            callback(cluster.workers[id]);
        }
    }

    function kill(worker) {
        process.kill(worker.process.pid, 'SIGHUP');
    }

    function workerError(worker, timeoutInMs, state, next) {
        logger.log('debug', 'M|worker-id=' + worker.id + '|TIMEOUT|Took more than ' + (timeoutInMs /1000) + 'sec to ' + state, meta);
        if (typeof(next) === 'function') {
            return next(worker);
        }
        return null;
    }
    
    function wokerStarted(id) {
        workerQueue.execute(id, function (err, node, next) {
            node.state = 'listening';
            clearTimeout(node.timeout);
            node.timeout = null;
            delete node.timeout;
            if (workerQueue.isEmpty()) {
                node.deferred.resolve({
                    "id"     : node.id,
                    "worker" : node.worker,
                    "state"  : state === states.reloading ? 'restarted' : 'started'
                });
                process.nextTick(function () {
                    actionQueue.deferred.resolve({
                        "id"     : node.id,
                        "worker" : node.worker,
                        "state"  : "listening",
                        "action" : state === states.reloading ? "reload" : "start"
                    });
                });
                logger.log('debug', '***** STATE ' +  states.toString(state) + ' --> ' + states.toString(states.running));
                state = states.running;
            }
            return null;
        });
    }
    
    function fsReload() {
        var promise = reload();
        promise.done(function() {
            logger.log('info', 'fs.watch()|Reload Completed');
        });
    }


    
    return {
        "start"      : start,
        "stop"       : stop,
        "shutdown"   : shutdown,
        "reload"     : reload
    };
};
