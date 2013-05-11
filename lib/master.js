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
        savedConfig = config,
        states = {
            "stopped"      :  0,
            "starting"     :  1,
            "stopping"     :  2,
            "restarting"   :  3,
            "running"      :  4,
            "exiting"      :  5,
            "timeout"      :  6,
            "error"        :  7,
            "toString"     : function (state) {
                for (var stateName in states) {
                    if (states.hasOwnProperty(stateName) && states[stateName] === state)
                        return stateName;
                }
                return 'unknown(' + state + ')';
            }
        },
        state        = states.stopped;
        
    setupObservers();

    
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
    function start() {
        logger.log('debug', 'M|start', meta);
        var deferred = Q.defer();  // resolved by the 'listening' event
        actionQueue.add({
            "action" : "start",
            "params" : {
                "deferred" : deferred,
                "options"  : savedConfig.options
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
        logger.log('debug', 'M|shutdown', meta);
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
        logger.log('debug', 'M|stop', meta);
        var deferred = Q.defer();  // resolved by the 'exit' event
        actionQueue.add({
            "action" : "shutdown",
            "params" : {
                "forcefull" : true,
                "deferred"  : deferred
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
    function restart() {
        var deferred = Q.defer();  // resolved by the 'listening' event
        logger.log('debug', 'M|restart', meta);
        actionQueue.add({
            "action" : "restart",
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
                logger.log('debug', 'M|actionQueue::execute|obj=%j', +obj, meta);
                return null;
            }
        }).on(['add', 'insert'], function (event, node) {
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
                    logger.log('debug', 'M|Queue::on|event=%s|creating Promise', event, meta);
                    actionQueue.deferred = Q.defer(); // resolved by the 'listening' or 'exit' event
                    // Setup a Promise for the ActionQueue, to execute the next
                    // Action, o matter if the promise is resolved or rejected
                    actionQueue.deferred.promise.then(function () {
                        logger.log('debug', 'M|Queue::on|event=%s|action=%s|resoleved|nullifying Promise', event, node.action, meta);
                        actionQueue.deferred = null;
                        executeNextTask();
                    }).fail(function() {
                        logger.log('warn', 'M|Queue::on|event=%s|action=%s|REJECTED|nullifying Promise', event, node.action, meta);
                        actionQueue.deferred = null;
                        executeNextTask();
                    }).done();
                    
                    // Once we setup the Promise for the ActionQueue we execute
                    // the next action in the queue, if there is one.
                    process.nextTick(function () {
                        logger.log('debug', 'M|Queue::nextTick|execute', meta);
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
                return (key === null || node.worker.id === key);
            }
        }),
        onTimeoutErrorExit = true;
        
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
        logger.log('debug', 'M|startAction|params=%j', params, meta);
        
        // 1) Make sure the Engine is in the STOPPED state before spinnig up
        //    all the workers.
        if (state !== states.stopped) {
            logger.log('warn', 'M|startAction|ERROR|REJECT');
            params.deferred.reject({
                "module"   : meta.module,
                "action"   : "start",
                "code"     : 400,
                "error"    : "Bad Request",
                "message" : "Unable to start. Invalid state '" + states.toString(state) + "'. Expected 'stopped'"
            });
            logger.debug('M|startAction|params=%j|done', params, meta);
            return null;
        }
        
        // 2) Changing state to "Starting" and FORKing all the workers.
        //    Further more we will send a message to each of them with a "start"
        //    Action.
        nextState(states.starting);
        for (var w = 0 ; w < savedConfig.workers ; ++w) {
            startOneWorkerHelper();
        }
        
        // 3) Use the monitorAllWorkerHelper function to Queue all the workers an monitor
        //    their startup progress.
        var promises = monitorAllWorkerHelper('start', savedConfig.startTimeoutInMs);
        Q.all(promises).then(function (object) {
            logger.log('debug', 'M|startAction|all|resolved|object=%j', object, meta);
            nextState(states.running);

            // 3.1)  Notify the callee that the requested start "Action" has
            //       succeeded.
            params.deferred.resolve();
            /*{
                "module"   : meta.module,
                "action"   : "start",
                "code"     : 200,
                "error"    : "OK",
                "message" : "All " +  savedConfig.workers + " workers started"
            });*/
            
            // 3.2) Change the ActionQueue state to RESOLVE to make it execute
            //      the next action in its queue.
            process.nextTick(function () {
                actionQueue.deferred.resolve();/*{
                    "state"  : "started",
                    "action" : "start"
                });*/
            });
        }).fail(function (object) {
            logger.log('debug', 'M|startAction|all|rejected|object=%j', object, meta);
            nextState(states.error);

            // 3.3)  Notify the callee that the requested start "Action" has
            //       FAILED.
            logger.log('warn', 'M|startAction|ERROR|REJECT');
            params.deferred.reject({
                "module"   : meta.module,
                "action"   : "start",
                "code"     : 400,
                "error"    : "Bad Request",
                "message" : "Unable to start. Some workers refuse to start."
            });

            // 3.4) Change the ActionQueue state to REJECTED to make it execute
            //      the next action in its queue.
            process.nextTick(function () {
                logger.log('debug', 'M|startAction|ERROR|nextTick|actionQueue.deferred.REJECT', meta);
                actionQueue.deferred.reject({
                    "state"  : "error",
                    "action" : "start"
                });
            });
        }).done();
        
        // 4) Return null, to inform the ActionQueue that this action should not
        //    be reinstered into the queue.
        logger.log('debug', 'M|startAction|params=%j|done', params, meta);
        return null;
    }
        
    /**
     * @private
     * 
     * Shutdown gracefully the enging if the state is 'running'
     * 
     * @param params  an object containing:
     *           deferred  The Promise that we must resolve or reject
     *           forcefull Kill all the workers instead of disconnecting them
     */
    function shutdownAction(params) {
        logger.log('debug', 'M|shutdownAction|params=%j', params, meta);
        var forcefull = params.forcefull ? true : false;
        var action = forcefull ? 'stop' : 'shutdown';
        
        // 1) Make sure the Engine is in the RUNNING state before asking all the
        //    workers to disconnect.
        if (state !== states.running && state !== states.error) {
            logger.log('warn', 'M|shutdownAction|ERROR|REJECT');
            params.deferred.reject(new Error(JSON.stringify({
                "module"   : meta.module,
                "action"   : action,
                "code"     : 400,
                "error"    : "Bad Request",
                "message" : "Unable to " + action + ". Invalid state '" + states.toString(state) + "'. Expected 'running' or 'error'"
            })));
            return null;
        }
        
        // 2) Changing state to "Stopping" and use the monitorAllWorkerHelper function to 
        //    Queue all the workers, to monitor their shutting down progress.
        nextState(states.stopping);
        var promises = monitorAllWorkerHelper(action, forcefull ? savedConfig.stopTimeoutInMs : savedConfig.shutdownTimeoutInMs);
        Q.all(promises).then(function (object) {
            logger.log('debug', 'M|%sAction|all|resolved|object=%j', action, object, meta);
            nextState(states.stopped);
            
            // 2.1)  Notify the callee that the requested shutdown "Action" has
            //       succeeded.
            params.deferred.resolve();/*{
                "module"   : meta.module,
                "action"   : action,
                "code"     : 200,
                "error"    : "OK",
                "message" : "All " +  savedConfig.workers + " workers are stopped."
            });*/
            
            // 2.2) Change the ActionQueue state to RESOLVE to make it execute
            //      the next action in its queue.
            process.nextTick(function () {
                actionQueue.deferred.resolve();/*{
                    "state"  : "stopped",
                    "action" : action
                });*/
            });
        }).fail(function (object) {
            logger.log('debug', 'M|%sAction|all|rejected|object=%j', action, object, meta);
            nextState(states.error);

            // 2.3)  Notify the callee that the requested shutdown "Action" has
            //       FAILED.
            logger.log('warn', 'M|shutdownAction|ERROR|REJECT');
            params.deferred.reject({
                "module"   : meta.module,
                "action"   : action,
                "code"     : 400,
                "error"    : "Bad Request",
                "message" : "Unable to " + action + ". Some worker refused to die."
            });

            // 2.4) Change the ActionQueue state to REJECTED to make it execute
            //      the next action in its queue.
            process.nextTick(function () {
                logger.log('debug', 'M|shutdownAction|ERROR|nextTick|actionQueue.deferred.REJECT', meta);
                actionQueue.deferred.reject({
                    "state"  : "error",
                    "action" : action
                });
            });
        }).done();
        
        // 3) Ask nicely all the worker to stop accepting connection and exit.
        if (forcefull) {
            eachWorker(function (worker) {
                worker.process.kill();
            });
        } else {
            cluster.disconnect(function () {
                logger.debug('M|%s|disconnected|ALL-WORKERS-ARE-DEAD', action, meta);
            });
        }
        
        // 4) Return null, to inform the ActionQueue that this action should not
        //    be reinstered into the queue.
        return null;
    }
    
    function actionCompleted(action, newState, resolved, code, message, params) {
        logger.log('debug', 'M|%sAction|%s|%s', action, action, (resolved ? 'resolved' : 'rejected'), meta);
        nextState(newState);

        if (resolved) {
            params.deferred.resolve(); /*{
                "module"   : meta.module,
                "action"   : action,
                "code"     : code,
                "error"    : "OK",
                "message" : message
            });*/
            process.nextTick(function () {
                actionQueue.deferred.resolve();/*{
                    "state"  : action,
                    "action" : action
                });*/
            });
        } else {
            logger.log('warn', 'M|actionCompleted|ERROR|%s|actionQueue.deferred.REJECT', action, meta);
            params.deferred.reject({
                "module"   : meta.module,
                "action"   : action,
                "code"     : code,
                "error"    : "OK",
                "message" : message
            });
            process.nextTick(function () {
                logger.log('debug', 'M|%sAction|ERROR|nextTick|actionQueue.deferred.REJECT', action, meta);
                actionQueue.deferred.reject({
                    "state"  : action,
                    "action" : action
                });
            });
        }

        
    }
    /**
     * @private
     * 
     * Reload the server 'script' and restart all the worker 'threads'
     * 
     * @param params  an object containing:
     *           deferred The Promise that we must resolve or reject
     */
    function restartAction(params) {
        logger.log('debug', 'M|restartAction|params=%j', params, meta);
        
        // 1) Make sure the Engine is in the RUNNING state before asking all the
        //    workers to restart.
        if (state !== states.running) {
            logger.log('debug', 'M|restartAction|ERROR|REJECT', meta);
            params.deferred.reject(new Error(JSON.stringify({
                "module"   : meta.module,
                "action"   : "restartAction",
                "code"     : 400,
                "error"    : "Bad Request",
                "message" : "Unable to restart. Invalid state '" + states.toString(state) + "'. Expected 'running'."
            })));
            return null;
        }
        
        // 2) Change the state from 'running' to restarting
        nextState(states.restarting);
        
        // 3) Clone the Current workers, to keep track of them.
        var currentWorkers = [];
        eachWorker(function (worker) {
            currentWorkers.push(worker);
        });
        
        
        
        var cycleWorkers = function (workersToShutdown) {
            logger.log('debug', 'M|restart|workerToShutdown=%d', workersToShutdown.length, meta);
            
            var newWorker    = startOneWorkerHelper();
            var startPromise = monitorOneWorkerHelper("start", savedConfig.startTimeoutInMs, newWorker);
            
            // 1) Start a new worker to replace an old one.
            startPromise.then(function (object) {
                logger.log('debug', 'M|worker-id=%d|restart|started', newWorker.id, meta);
                var oneWorker = workersToShutdown.shift();
                var stopPromise = monitorOneWorkerHelper("shutdown", savedConfig.shutdownTimeoutInMs, oneWorker);
                logger.log('debug', 'M|worker-id=%d|restart|stop', oneWorker.id, meta);
                oneWorker.disconnect();
                stopPromise.then(function (object) {
                    logger.log('debug', 'M|worker-id=%d|restart|stopped', oneWorker.id, meta);
                    if (workersToShutdown.length === 0) {
                        actionCompleted("restart", states.running, true, 200, 'Workers restarted', params);                        
                    } else {
                        cycleWorkers(workersToShutdown);
                    }
                    logger.log('debug', 'M|worker-id=%d|restart|unwinding', oneWorker.id, meta);
                }).fail(function (object) {
                    logger.log('debug', 'M|restartAction|stop|rejected|object=%j', object, meta);
                    actionCompleted("restart", states.error, true, 400, 'A worker failed to shudown', params);                        
                });
            }).fail(function (object) {
                logger.log('debug', 'M|restartAction|start|rejected|object=%j', object, meta);
                actionCompleted("restart", states.error, true, 400, 'A worker failed to start', params);                        
            }).done();
        };

        // 3) Start one worker and shutdown another
        cycleWorkers(currentWorkers);
        
        // 4) Return null, to inform the ActionQueue that this action should not
        //    be reinstered into the queue.
        return null;
    }

    ////////////////////////////////////////////////////////////////////////////
        
        
    function setupObservers() {
        
        /*
         * In case a worker does not start an http server, it can send a message
         * to stop the 'timer' that would kill this worker if it does not start
         * listening
         */
        process.on('message', function (msg) {
            logger.log('debug', 'M|worker-id=%d|on=message|message=%j', msg.id, msg, meta);
            if (msg.origin === 'worker') {
                if (msg.action === 'listening') {
                    workerHelperDone('listening', cluster.workers[msg.id]);
                } else  {
                    logger.log('warn', 'M|on=message|UNKNOWN|message=%j', msg, meta);
                }
            }
        });

        cluster.on('fork', function(worker) {
            logger.log('debug', 'M|worker-id=%d|on=fork', worker.id, meta);
            workerQueue.execute(worker.id, function (err, node, next) {
                node.state = 'forked';
                return node;
            });
        });
        
        cluster.on('online', function(worker) {
            logger.log('debug', 'M|worker-id=%d|on=online', worker.id, meta);
            workerQueue.execute(worker.id, function (err, node, next) {
                node.state = 'online';
                return node;
            });
        });  

        cluster.on('listening', function(worker, address) {
            logger.log('debug', 'M|worker-id=%d|on=listening|address=%s:%d', worker.id, address.address, address.port, meta);
            workerHelperDone('listening', worker);
        });
        
        cluster.on('disconnect', function(worker) {
            logger.log('debug', 'M|worker-id=%d|on=disconnect', worker.id, meta);
            workerQueue.execute(worker.id, function (err, node, next) {
                node.state = 'disconnected';
                return node;
            });
        });
        
        cluster.on('exit', function(worker, code, signal) {
            logger.log('debug', 'M|worker-id=%d|on=exit|code=%s|signal=%s|%s', worker.id, code, signal, (worker.suicide ? 'suicide' : 'MURDER'), meta);
            workerHelperDone('exited', worker);
        });

        // --- When the MASTER process is killed, lets kill all the worker threads
        //
        process.on('SIGTERM', function () {
            var exitCode = 0;
            if (state === states.running) {
                logger.info('M|SIGTERM|state=%s|all-stop', states.toString(state), meta);
                stop().then(function () {
                    logger.info('M|SIGTERM|all workers dead', meta);
                    process.nextTick(function() {
                        logger.info('M|SIGTERM|exiting|code=' + exitCode, meta);
                        process.exit(exitCode);
                    });
                }).fail(function() {
                    logger.info('M|SIGTERM|filed', meta);
                    process.nextTick(function() {
                        logger.info('M|SIGTERM|exiting|code=' + exitCode, meta);
                        process.exit(exitCode);
                    });
                }).done();
            } else {
                logger.info('M|SIGTERM|state=%s|SIGKILL all workers', states.toString(state), meta);
                eachWorker(function(worker) {
                    worker.process.kill('SIGKILL');
                });
                logger.info('M|SIGTERM|state=%s|kill-timer=%f', savedConfig.stopTimeoutInMs, meta);
                setTimeout(function() {
                    logger.info('M|SIGTERM|timeout|exit=%d', exitCode, meta);
                    process.exit(exitCode);
                }, savedConfig.stopTimeoutInMs);
            }
        });
    }

    ///////////////////////////////////////////////////////////////////////////

    function eachWorker(callback) {
        for (var id in cluster.workers) {
            callback(cluster.workers[id]);
        }
    }

    function schedule(param, timeoutInMs, next) {
        var timer = setTimeout((function(p, t, n) {
            return function() {
                if (typeof(n) === 'function') {
                    n(p, t);
                }
            };
        })(param, timeoutInMs, next), timeoutInMs);
        return timer;
    }

    /**
     * @private
     * 
     * When performing an "Action" on workers, this function will queue a node
     * foreach worker and associate a timeer to monitor its progress. If the
     * worker does not change state in a timely fashion, it will get killed
     * and the "Action" promise will be Rejected.
     * 
     * @param action            The name of the action, mainly for logging
     * @paran firstTimeoutInMs  The expected time for the action to take place
     * 
     * @returns promises An Array of promises that will be either Resolve or
     *                   Rejected at a future time.
     */
    function monitorAllWorkerHelper(action, firstTimeoutInMs) {
        logger.log('debug', 'M|%s', action, meta);
        
        // 1) Iterate each worker and queue a node into the workerQueue to 
        //    monitor its progress.
        var promises = [];
        eachWorker(function (worker) {
            promises.push(monitorOneWorkerHelper(action, firstTimeoutInMs, worker));
        });
        return promises;
    }
    
    /**
     * @private
     * 
     * When performing an "Action" on workers, this function will queue a node
     * foreach worker and associate a timeer to monitor its progress. If the
     * worker does not change state in a timely fashion, it will get killed
     * and the "Action" promise will be Rejected.
     * 
     * @param action            The name of the action, mainly for logging
     * @paran firstTimeoutInMs  The expected time for the action to take place
     * 
     * @returns promises An Array of promises that will be either Resolve or
     *                   Rejected at a future time.
     */
    function monitorOneWorkerHelper(action, firstTimeoutInMs, worker) {
        logger.log('debug', 'M|worker-id=%d|%s', worker.id, action, meta);
        
        // 1) Create a Promise for this worker
        var deferred = Q.defer();
        workerQueue.add({
            "action"   : action,
            "state"    : "pending",
            "worker"   : worker,
            "deferred" : deferred,
            "timeout"  : schedule(worker, firstTimeoutInMs, function(worker, timeoutInMs) {
                logger.log('debug', 'M|worker-id=%d|%s|first-timeout', worker.id);
                
                // 1.1) If the worker did not change state within "firstTimeoutInMs",
                //      KILL it and let the Observer deal with either Resolving or
                //      Rejected depening if we where Starting or Stopping.
                //      (e.g. if we were stopping and it did not respond to the
                //            disconnect, but the kill worked, then the Stop Action
                //            would still be a success. However, if we were starting
                //            and the kill worked, it should NOT be a success!)
                workerQueue.execute(worker.id, function (err, node, next) {
                    logger.log('warn', 'M|worker-id=%d|%s|not-responding|SIGKILL|worker did not %s in %f secs.', node.worker.id, action, action, (timeoutInMs /1000), meta);
                    node.worker.process.kill('SIGKILL');
                    node.timeout = schedule(worker, savedConfig.stopTimeoutInMs, function(worker, timeoutInMs) {
                        logger.log('debug', 'M|worker-id=%d|%s|second-timeout', worker.id);
                        
                        // 1.2) If the worker did not DIE when we killed it, the
                        //      whole Enging is in a bad state, we have to reject
                        //      the Promise and ... Notify the "main application"
                        //      that started the server to let it decice what to
                        //      do (e.g. exit and let the OS restart?!)
                        workerQueue.execute(worker.id, function (err, node, next) {
                            logger.log('error', 'M|worker-id=%d|%s|not-responding|REJECT|worker did not die in %f secs.**************************************************', node.worker.id, action, (timeoutInMs /1000), meta);
                            nextState(states.timeout, node.worker.id); // 'M|worker-id=' + node.worker.id + '|monitorOneWorkerHelper|' + action +'|TIMEOUT|on=kill', 
                            node.deferred.reject({
                                "module"   : meta.module,
                                "action"   : action,
                                "code"     : 400,
                                "error"    : "Bad Request",
                                "message" : "Unable to " + action  + " worker-id " + node.worker.id + "."
                            });
                            
                            // 1.3) Notify the WorkerQueue that this worker
                            //      node has been processed and should not
                            //      be reinsterted into the queue.
                            return null;
                        });
                    });
                    
                    // 1.4) Notify the WorkerQueue that this worker
                    //      node is still active and should be reinserted
                    //      into the queue.
                    return node;
                });
            })
        });
        
        // 2) return the promise
        return deferred.promise;
    }
            

    function workerHelperDone(action, worker) {
        logger.log('debug', 'M|worker-id=%d|workerHelperDone|on=%s', worker.id, action, meta);
        workerQueue.execute(worker.id, function (err, node, next) {
            node.state = action;
            clearTimeout(node.timeout);
            node.timeout = null;
            delete node.timeout;
            node.deferred.resolve();/*{
                "action" : action,
                "worker" : node.worker
            });*/
            logger.log('debug', 'M|worker-id=%d|workerHelperDone|on=%s|invalidate-timer|RESOLVED', node.worker.id, action, meta);
            return null;
        });
    }
    
    function startOneWorkerHelper() {
        var worker   = cluster.fork();
        logger.log('debug', 'M|worker-id=%d|send|action=start', worker.id);
        worker.send({
            "action"   : "start",
            "id"       : worker.id,
            "origin"   : meta.module,
            "options"  : savedConfig.options,
            "server"   : {
                "start"      : start,
                "stop"       : stop,
                "shutdown"   : shutdown,
                "reload"     : restart
            }
        });
        return worker;
    }

    function nextState(newState, id) {
        if (newState !== state) {
            logger.log('debug', 'M%s|***** STATE %s --> %s', (id ? '|worker-id=' + id : ''), states.toString(state), states.toString(newState), meta);
            state = newState;
        }
    }
    
    return {
        "start"      : start,
        "stop"       : stop,
        "shutdown"   : shutdown,
        "restart"    : restart
    };
};
