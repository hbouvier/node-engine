# High Availability Cluster Engine/Container

This module can be installed either as a Container for an existing Node.js
server script, to make it Highly Available using Node Cluster or embeded as a
module dependency inside antoher Node.js server.

#LICENSE:

This module is licensed under the Apache License v2.0

# Usage as a Container

npm install -g node-engine

node-engine path/to/existing/server.js -- parameters to exisiting server

Example: to make your script 'httpServer.js' that need a command line argument of
'port=8080' Highly Available, you would invoke it like this:

    node-engine httpServer.js -- port=8080

# Include this as a module in your own project

## mainWithServer.js
    var engine = require('node-engine'),
        server = engine({
            "script"       : "./MyHttpServer.js"
        });
    if (server) {
        server.then(function () {
            console.log('server started');
        }).fail(function (reason) {
            console.log('server fail: ', reason);
            process.exit(-1);
        });
    } else {
        console.log('worker started');
    }
    
## MyHttpServer.js
    var app = require('express')();
    
    app.get('/', function(req, res) {
        res.end('Hello World');
    });
    
    app.listen(process.env.PORT);

## If you prefer to package your server as a module to receive notification
## when starting and stopping

## mainWithModule.js

    var engine = require('node-engine'),
        server = engine({
            "script"       : "./MyHttpModule.js",
            "scriptConfig" : {
                "port"         : options.port
            },
        });
        
    if (server) {
        server.then(function () {
            console.log('server started');
        }).fail(function (reason) {
            console.log('server fail: ', reason);
            process.exit(-1);
        });
    } else {
        console.log('worker started');
    }
    
## MyHttpModule.js
    module.exports = function () {
        var app = require('express')();
        
        function start(options) {
            app.get('/', function(req, res) {
                res.end('Hello World');
            });
            
            app.listen(options.port);
        }
        function stop(forcefull) {
            console.log('stopping ' + (forcefull ? 'forcefully' : ''));
        }

        return {
            "start"         : start,
            "stop"          : stop
        };
    }();
    

## Other configuration options that can be passed to the Engine
    var winston = require('winston),
        engine  = require('node-engine'),
        server  = engine({
            "workers"      : os.cpus().length,
            "script"       : "./MyHttpServer.js",
            "scriptArgv"   : ['--user=bob', '--password=SuperSecret'],
            "scriptConfig" : {
                "port"         : process.env.PORT
            },
            "startTimeoutInMs"    : 5000,
            "shutdownTimeoutInMs" : 5000,
            "stopTimeoutInMs"     : 1000,
            "logger" : new (winston.Logger)({transports: [
                new (winston.transports.Console)({
                                                    "level"    : "verbose",
                                                    "json"     : false,
                                                    "colorize" : true
                })
            ]});
        });
        
workers      : Number of worker process (minimum=1, default=Number of CPU)
script       : Path to the server script / module
scriptArgv   : Command Line arguments (e.g. process.argv_ passed to the server script
scriptConfig : When the server script is a module, the "start" function of that
               module will be invoked with a configuration object containing the
               "scriptConfig" object as-is.
logger       : An instance of "winston" logger to use for loging.
shutdownTimeoutInMs : The maximum time allowed, in milli-seconds, for a worker
                      to shutdown nicely (e.g. time to finish precessing its
                      current request. If it does not finish in that time it will
                      be killed by the engine.
stopTimeoutInMs     : The maximum time allowed, in milli-seconds, for a worker
                      to die when killed, if it does not die in the allowed time
                      the server will consider this as an engine failure and go
                      into an error state.
startTimeoutInMs    : The maximum time allowed, in milli-seconds, for a worker
                      to start listening for incoming connection. If the worker
                      is not ready to process request in that time it will be
                      killed by the engine. If ther 'server' does not listen
                       (e.g. it is not a networking server) it has to send a
                      message to the Enging to notify it that it is ready like
                      this:
                      
    process.send({
            "action"     : "listening",
            "id"         : cluster.worker.id,
            "origin"     : 'worker'
        });                      
                      
