module.exports = function () {
    var diag     = require('node-diagnostics').setPrefix(['master']),
        fs       = require('fs'),
        cluster  = require('cluster'),
        timeouts = [],
        shouldRun = true,
        startTimeout = 30000,
        startOptions = null;

    function start(script, options) {
        if (diag.level >= diag.fine) diag.log(diag.fine, 'starting|nb-workers=' + options.workers);
        startOptions = options;
        setupObservers();
        for (var i = 0 ; i < options.workers ; ++i) {
            startOneWorker();
        }
        fs.watch(script + '.js', {persistent: true, interval: 1}, reload);
    }
    
    function startOneWorker() {
        var worker = cluster.fork();
        worker.send({
            "id"       : worker.id,
            "origin"   : "master",
            "command"  : "setLevel",
            "level"    : diag.level
        });
        worker.send({
            "id"      : worker.id,
            "origin"  : "master",
            "command" : "start",
            "options" : startOptions
        });
    }
    
    function stop() {
        cluster.disconnect(function () {
            if (diag.level >= diag.fine) diag.log(diag.fine, 'stop|disconnect|ALL-WORKERS-ARE-DEAD');
        });
    }
    
    var reloadIDs;
    function reload() {
        reloadIDs = [];
        for (var id in cluster.workers) {
            reloadIDs.push(id);
        }
        if (diag.level >= diag.finest) diag.log(diag.finest, 'reload|workers=' + reloadIDs.join(', '));
        restartOneWorkers();
    }
    
    function restartOneWorkers() {
        if (reloadIDs && reloadIDs.length > 0) {
            var id = reloadIDs.shift();
            if (id) {
                if (diag.level >= diag.finest) diag.log(diag.finest, 'restartOneWorkers|id=' + id + '|workers=' + reloadIDs.join(', '));
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
        var timeoutms = startTimeout;
        
        cluster.on('fork', function(worker) {
            if (diag.level >= diag.finest) diag.log(diag.finest, worker.id + '|on=fork');
            timeouts[worker.id] = setTimeout((function (w, to) {
                return function() {
                    workerStartupError(w, to);
                }
            })(worker, timeoutms), timeoutms);
        });
        
        cluster.on('online', function(worker) {
            if (diag.level >= diag.finest) diag.log(diag.finest, worker.id + '|on=online');
        });  

        cluster.on('listening', function(worker, address) {
            clearTimeout(timeouts[worker.id]);
            delete timeouts[worker.id];
            restartOneWorkers();
            if (diag.level >= diag.fine) diag.log(diag.fine, worker.id + '|on=listening|address=' + address.address + ':' + address.port + '|is listening');
        });
        
        cluster.on('disconnect', function(worker) {
            if (diag.level >= diag.finest) diag.log(diag.finest, worker.id + '|on=disconnect');
        });        
        
        cluster.on('exit', function(worker, code, signal) {
            if (diag.level >= diag.finest) diag.log(diag.finest, worker.id + '|on=exit|code='+ code + '|signal=' + signal + (worker.suicide ? '|suicide' : ''));
            if (shouldRun) {
                startOneWorker();
            }
        });
        
        // --- When the MASTER process is killed, lets kill all the worker threads
        //
        process.on('SIGTERM', function () {
            shouldRun = false;
            if (diag.level >= diag.finest) diag.log(diag.finest, 'SIGTERM|Killing all workers');
            eachWorker(function (worker) {
                if (diag.level >= diag.finest) diag.log(diag.finest, worker.id + '|SIGTERM|Killing');
                worker.process.kill();
            });
            setTimeout(function() {
                var exitCode = 1;
                if (diag.level >= diag.finest) diag.log(diag.finest, 'SIGTERM|EXITING='+exitCode);
                process.exit(exitCode);
            }, 5000);
        });
        
    }
    
    
    function workerStartupError(worker, timeoutms) {
        if (diag.level >= diag.finest) diag.log(diag.finest, worker.id + 'TIMEOUT|Took more than ' + (timeoutms /1000) + 'sec to start');
        worker.process.kill();
    }
    
    return {
        "setLevel"  : function (level) { diag = diag.setLevel(level); },
        "start"      : start,
        "stop"       : stop
    };
}();
