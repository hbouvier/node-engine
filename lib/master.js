/**
 * @public
 * 
 * Start an instance of the Engine
 * 
 * @param config  Configuration for the server
 * 
 *            workers  Number of "threads" to run
 * 
 *            startTimeoutInMs If a worker does start "listening" in that amount
 *                             of MiliSeconds, it will be killed.
 *                            
 *            stopTimeoutInMs  If a worker does not stop (when killed) in that
 *                             amount of MiliSeconds, it will be killed.
 * 
 *            shutdownTimeoutInMs  If a worker does not shutdown in that amount
 *                                 of MiliSeconds, it will be killed.
 * 
 */
module.exports = function (config) {
    var cluster  = require('cluster'),
        Q        = require('q'),
        Queue    = require('./Queue').Queue,
        logger   = config.logger ? config.logger : { "log" : function () {} },
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
            "error"        :  5,
            "toString"     : function (state) {
                for (var stateName in states) {
                    if (states.hasOwnProperty(stateName) && states[stateName] === state)
                        return stateName;
                }
                return 'unknown(' + state + ')';
            }
        },
        state = states.stopped;

    // Main initialisation of the Master
    //
    setupObservers();

    ////////////////////////////////////////////////////////////////////////////
    //
    //                           PUBLIC API
    //
    ////////////////////////////////////////////////////////////////////////////
    //
    
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
     *            startTimeoutInMs If a worker does start "listening" in that amount
     *                             of MiliSeconds, it will be killed.
     *                            
     *            stopTimeoutInMs  If a worker does not stop (when killed) in that
     *                             amount of MiliSeconds, it will be killed.
     * 
     *            shutdownTimeoutInMs  If a worker does not shutdown in that amount
     *                                 of MiliSeconds, it will be killed.
     * 
     *            options  The options to be passed to the worker threads
     * 
     */
    function start() {
        logger.log('debug', 'M|start', meta);
        var deferred = Q.defer();  // resolved by the 'listening' event
        actionQueue.add({
            "action" : "start",
            "params" : {
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
     * It Will cycle through all the worker, first by start a new worker,
     * wait for it to be listening form incoming request and then make
     * the "older" worker stop listening for request, finish processing the
     * requests already in progress and then terminating it (the old one). 
     * Reperating this procedure for each worker that was running, until all
     * the workers are restarted.
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
    //
    //                              PRIVATE 
    //
    ////////////////////////////////////////////////////////////////////////////
    //

    /**
     * The "actionQueue" is where the Public methods queue "start", "stop",
     * "shutdown" and "restart" function calls to be executed, in sequence by
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
         * (e.g. starting, stopping or restarting them)
         */
        workerQueue = new Queue('workerQueue', {
            "search" : function (key, node) {
                return (key === null || node.worker.id === key);
            }
        });
        
    ////////////////////////////////////////////////////////////////////////////
    //
    //                    PRIVATE API IMPLEMENTATION
    //
    ////////////////////////////////////////////////////////////////////////////
    //
    
    /**
     * @private
     * 
     * start the enging if the state is 'stopped'
     * 
     * @param params  an object containing:
     *                    deferred The Promise that we must resolve or reject
     */
    function startAction(params) {
        logger.log('debug', 'M|startAction|params=%j', params, meta);
        
        // 1) Make sure the Engine is in the STOPPED state before spinnig up
        //    all the workers.
        if (state !== states.stopped) {
            logger.log('warn', 'M|startAction|ERROR|REJECT');
            params.deferred.reject(new Error('Unable to start workers. Invalid state ' + states.toString(state) + '. Expected stopped'));
            logger.log('debug', 'M|startAction|params=%j|done', params, meta);
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
            actionCompleted("start", states.running, true, 'Workers started', params);                        
        }).fail(function (object) {
            logger.log('debug', 'M|startAction|all|rejected|object=%j', object, meta);
            actionCompleted("start", states.error, false, 'Unable to start workers', params);                        
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
            params.deferred.reject(new Error('Unable to ' + action + ' workers. Invalid state ' + states.toString(state) + '. Expected running or error'));
            return null;
        }
        
        // 2) Changing state to "Stopping" and use the monitorAllWorkerHelper function to 
        //    Queue all the workers, to monitor their shutting down progress.
        nextState(states.stopping);
        eachWorker(function(worker) {
            worker.send({
                "action"     : "stop",
                "id"         : worker.id,
                "origin"     : meta.module,
                "methodArgs" : [forcefull]
            });
        });
        var promises = monitorAllWorkerHelper(action, forcefull ? savedConfig.stopTimeoutInMs : savedConfig.shutdownTimeoutInMs);
        Q.all(promises).then(function (object) {
            logger.log('debug', 'M|%sAction|all|resolved|object=%j', action, object, meta);
            actionCompleted("shutdown", states.stopped, true, 'All workers shutdown', params);                        
        }).fail(function (object) {
            logger.log('debug', 'M|%sAction|all|rejected|object=%j', action, object, meta);
            actionCompleted("shutdown", states.error, false, 'Unable to stop workers', params);                        
        }).done();
        
        // 3) Ask nicely all the worker to stop accepting connection and exit.
        if (forcefull) {
            eachWorker(function (worker) {
                process.kill(worker.process.pid, 'SIGHUP');
            });
        } else {
            cluster.disconnect(function () {
                logger.log('debug', 'M|%s|disconnected|ALL-WORKERS-ARE-DEAD', action, meta);
            });
        }
        
        // 4) Return null, to inform the ActionQueue that this action should not
        //    be reinstered into the queue.
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
    function restartAction(params) {
        logger.log('debug', 'M|restartAction|params=%j', params, meta);
        
        // 1) Make sure the Engine is in the RUNNING state before asking all the
        //    workers to restart.
        if (state !== states.running) {
            logger.log('debug', 'M|restartAction|ERROR|REJECT', meta);
            params.deferred.reject(new Error('Unable to restart workers. Invalid state ' + states.toString(state) + '. Expected running.'));
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
                oneWorker.send({
                    "action"     : "stop",
                    "id"         : oneWorker.id,
                    "origin"     : meta.module,
                    "methodArgs" : [false]
                });
                oneWorker.disconnect();
                stopPromise.then(function (object) {
                    logger.log('debug', 'M|worker-id=%d|restart|stopped', oneWorker.id, meta);
                    if (workersToShutdown.length === 0) {
                        actionCompleted("restart", states.running, true, 'Workers restarted', params);                        
                    } else {
                        cycleWorkers(workersToShutdown);
                    }
                    logger.log('debug', 'M|worker-id=%d|restart|unwinding', oneWorker.id, meta);
                }).fail(function (object) {
                    logger.log('debug', 'M|restartAction|stop|rejected|object=%j', object, meta);
                    actionCompleted("restart", states.error, false, 'A worker failed to shudown', params);                        
                });
            }).fail(function (object) {
                logger.log('debug', 'M|restartAction|start|rejected|object=%j', object, meta);
                actionCompleted("restart", states.running, false, 'A worker failed to start', params);                        
            }).done();
        };

        // 3) Start one worker and shutdown another
        cycleWorkers(currentWorkers);
        
        // 4) Return null, to inform the ActionQueue that this action should not
        //    be reinstered into the queue.
        return null;
    }

    ////////////////////////////////////////////////////////////////////////////
    //
    //                    PRIVATE - CLUSTER EVENT HANDLER
    //
    ////////////////////////////////////////////////////////////////////////////
    //
        
    function setupObservers() {
        
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
            
            // It is normal to have workers exit while we are stopping the engine
            if (state === states.stopping) {
                workerHelperDone('exited', worker);
            } else if (state === states.restarting || state === states.starting) {
                // While restarting, it is normal ONLY if the node is not in 'start'
                // mode (e.g. 'shutdown')
                var workerWasStarting = true;
                workerQueue.execute(worker.id, function (err, node, next) {
                    workerWasStarting = (node.action === 'start');
                    return node;
                });
                if (workerWasStarting) {
                    logger.log('error', 'M|worker-id=%d|died|%s', worker.id, states.toString(state), meta);
                    workerHelperFailed('start-failed', worker); // The restart command will fail!
                } else {
                    workerHelperDone('exited', worker);
                }
            } else if (state === states.running) {
                // Totally abnormal, let's restart that worker!
                logger.log('error', 'M|worker-id=%d|died|restarting', worker.id, meta);
                var newWorker    = startOneWorkerHelper();
                var startPromise = monitorOneWorkerHelper("start", savedConfig.startTimeoutInMs, newWorker);
                
                // Make sure it restart
                startPromise.then(function (object) {
                    logger.log('verbose', 'M|worker-id=%d|restart|started', newWorker.id, meta);
                }).fail(function (object) {
                    logger.log('error', 'M|worker-id=%d|restart|FAILED|only %d workers left!', newWorker.id, cluster.workers.length, meta);
                    if (cluster.workers.length === 0) {
                        logger.log('error', 'M|worker-id=%d|restart|FAILED|EXITING|No more workers!', newWorker.id, meta);
                        process.exit(-1);
                    }
                });
            }
        });

        // --- When the MASTER process is killed, lets kill all the worker threads
        //
        process.on('SIGTERM', function () {
            var exitCode = 0;
            if (state === states.running) {
                logger.log('ino', 'M|SIGTERM|state=%s|all-stop', states.toString(state), meta);
                stop().then(function () {
                    logger.log('info', 'M|SIGTERM|all workers dead', meta);
                    process.nextTick(function() {
                        logger.log('info', 'M|SIGTERM|exiting|code=' + exitCode, meta);
                        process.exit(exitCode);
                    });
                }).fail(function() {
                    logger.log('info', 'M|SIGTERM|failed', meta);
                    process.nextTick(function() {
                        logger.log('info', 'M|SIGTERM|exiting|code=' + exitCode, meta);
                        process.exit(exitCode);
                    });
                }).done();
            } else {
                logger.log('info', 'M|SIGTERM|state=%s|SIGKILL all workers', states.toString(state), meta);
                eachWorker(function(worker) {
                    worker.process.kill('SIGKILL');
                });
                logger.log('info', 'M|SIGTERM|state=%s|kill-timer=%s', states.toString(state), savedConfig.stopTimeoutInMs, meta);
                setTimeout(function() {
                    logger.log('info', 'M|SIGTERM|timeout|exit=%d', exitCode, meta);
                    process.exit(exitCode);
                }, savedConfig.stopTimeoutInMs);
            }
        });
    }

    ////////////////////////////////////////////////////////////////////////////
    //
    //                    PRIVATE - HELPER functions
    //
    ////////////////////////////////////////////////////////////////////////////
    //

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
    
    function actionCompleted(action, newState, resolved, message, params) {
        logger.log('debug', 'M|%sAction|%s|%s', action, action, (resolved ? 'resolved' : 'rejected'), meta);
        nextState(newState);

        if (resolved) {
            params.deferred.resolve();
            process.nextTick(function () {
                actionQueue.deferred.resolve();
            });
        } else {
            logger.log('warn', 'M|actionCompleted|ERROR|%s|actionQueue.deferred.REJECT', action, meta);
            params.deferred.reject(new Error(message));
            process.nextTick(function () {
                logger.log('debug', 'M|%sAction|ERROR|nextTick|actionQueue.deferred.REJECT', action, meta);
                actionQueue.deferred.reject(new Error('Unable to complete ' + action + 'Action. ' + message));
            });
        }
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
                logger.log('debug', 'M|worker-id=%d|%s|first-timeout', worker.id, action);
                
                // 1.1) If the worker did not change state within "firstTimeoutInMs",
                //      KILL it and let the Observer deal with either Resolving or
                //      Rejected depening if we where Starting or Stopping.
                //      (e.g. if we were stopping and it did not respond to the
                //            disconnect, but the kill worked, then the Stop Action
                //            would still be a success. However, if we were starting
                //            and the kill worked, it should NOT be a success!)
                workerQueue.execute(worker.id, function (err, node, next) {
                    logger.log('warn', 'M|worker-id=%d|%s|not-responding|SIGKILL|worker did not %s in %s secs.', node.worker.id, action, action, (timeoutInMs /1000), meta);
                    node.worker.process.kill('SIGKILL');
                    node.timeout = schedule(worker, savedConfig.stopTimeoutInMs, function(worker, timeoutInMs) {
                        logger.log('debug', 'M|worker-id=%d|%s|second-timeout', worker.id, action);
                        
                        // 1.2) If the worker did not DIE when we killed it, the
                        //      whole Enging is in a bad state, we have to reject
                        //      the Promise and ... Notify the "main application"
                        //      that started the server to let it decice what to
                        //      do (e.g. exit and let the OS restart?!)
                        workerQueue.execute(worker.id, function (err, node, next) {
                            logger.log('error', 'M|worker-id=%d|%s|not-responding|REJECT|worker did not die in %s secs.**************************************************', node.worker.id, action, (timeoutInMs /1000), meta);
                            nextState(states.error, node.worker.id); // 'M|worker-id=' + node.worker.id + '|monitorOneWorkerHelper|' + action +'|TIMEOUT|on=kill', 
                            node.deferred.reject(new Error('Unable to ' + action  + ' worker-id ' + node.worker.id + '.'));
                            
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
            node.deferred.resolve();
            logger.log('debug', 'M|worker-id=%d|workerHelperDone|on=%s|invalidate-timer|RESOLVED', node.worker.id, action, meta);
            return null;
        });
    }
    function workerHelperFailed(action, worker) {
        logger.log('debug', 'M|worker-id=%d|workerHelperFailed|on=%s', worker.id, action, meta);
        workerQueue.execute(worker.id, function (err, node, next) {
            node.state = action;
            clearTimeout(node.timeout);
            node.timeout = null;
            delete node.timeout;
            node.deferred.reject(new Error('Unable to ' + action  + ' worker-id ' + node.worker.id + '.'));
            logger.log('warn', 'M|worker-id=%d|workerHelperReject|on=%s|REJECT', node.worker.id, action, meta);
            return null;
        });
    }
    
    function startOneWorkerHelper() {
        var worker   = cluster.fork();
        logger.log('debug', 'M|worker-id=%d|send|action=start', worker.id);
        /*
         * In case a worker does not start an http server, it can send a message
         * to stop the 'timer' that would kill this worker if it does not start
         * listening
         */
        worker.on('message', function (msg) {
            logger.log('debug', 'M|worker-id=%d|on=message|message=%j', msg.id, msg, meta);
            if (msg.origin === 'worker') {
                if (msg.action === 'listening') {
                    workerHelperDone('listening', cluster.workers[msg.id]);
                } else if (msg.action === 'start') {
                    start().then(function() {
                        send(cluster.workers[msg.id], msg.action, 'success', null);
                    }).fail(function (reason) {
                        send(cluster.workers[msg.id], msg.action, 'fail', reason);
                    });
                } else if (msg.action === 'shutdown') {
                    shutdown().then(function() {
                        send(cluster.workers[msg.id], msg.action, 'success', null);
                    }).fail(function (reason) {
                        send(cluster.workers[msg.id], msg.action, 'fail', reason);
                    });
                } else if (msg.action === 'stop') {
                    stop().then(function() {
                        send(cluster.workers[msg.id], msg.action, 'success', null);
                    }).fail(function (reason) {
                        send(cluster.workers[msg.id], msg.action, 'fail', reason);
                    });
                } else if (msg.action === 'restart') {
                    restart().then(function() {
                        send(cluster.workers[msg.id], msg.action, 'success', null);
                    }).fail(function (reason) {
                        send(cluster.workers[msg.id], msg.action, 'fail', reason);
                    });
                } else  {
                    logger.log('warn', 'M|on=message|UNKNOWN|message=%j', msg, meta);
                }
            }
        });

        worker.send({
            "action"     : "start",
            "id"         : worker.id,
            "origin"     : meta.module,
            "script"     : savedConfig.script,
            "scriptArgv" : savedConfig.scriptArgv,
            "methodArgs" : savedConfig.scriptConfig
        });
        return worker;
    }
    
    function send(worker, action, status, reason) {
        worker.send({
            "action"     : action,
            "id"         : worker.id,
            "origin"     : meta.module,
            "status"     : status,
            "reason"     : reason
        });
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
