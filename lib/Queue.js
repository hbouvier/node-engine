var util     = require('util'),
    winston  = require('winston'),
    logger   = new (winston.Logger)({
        transports: [
            new (winston.transports.Console)({
                                                "level"    : "warn",
                                                "json"     : false,
                                                "colorize" : true
            }),
            new (winston.transports.File)({
                                                "filename" : "Queue.log",
                                                "level"    : "warn",
                                                "json"     : true,
                                                "colorize" : false
            })
        ]                
    }),
    meta     = { 
        "module" : "Queue",
        "pid"    : process.pid
    };
 
function Queue(name, search, executor) {
    this.name = name;
    this.queue        = [];
    this.searchFunc   = search;
    this.executorFunc = executor;
    return this;
}

Queue.prototype.add = function (node) {
    logger.log('debug', 'Queue|'+this.name+'|add|node=' + util.inspect(node));
    this.queue.push(node);
};

Queue.prototype.execute = function (key, next) {
    var node = null;
    
    logger.log('debug', 'Queue|'+this.name+'|execute|key=' + (typeof(key) === 'string' ? key : typeof(key)) + '|len=' + this.queue.length);
    if (!key || (typeof(key) === 'function' && !next)) {
        next = key;
        node = this.isEmpty() ? null : this.queue.shift();
        if (node) {
            logger.log('debug', 'Queue|'+this.name+'|execute|executor|node=' + util.inspect(node));
            node = this.executorFunc(null, node, next);
        }
    } else {
        for (var i = 0 ; i < this.queue.length ; ++i) {
            node = this.queue[i];
            if (this.searchFunc(key, node)) {
                this.queue.splice(i, 1);
                logger.log('debug', 'Queue|'+this.name+'|execute|executor|node=' + util.inspect(node));
                node = this.executorFunc(null, node, next);
                break;
            }
        }
    }
    if (node) {
        logger.log('debug', 'Queue|'+this.name+'|execute|re-inserting|node=' + util.inspect(node));
        this.queue.unshift(node);
    }
    logger.log('debug', 'Queue|'+this.name+'|execute|len=' + this.queue.length);
};

Queue.prototype.isEmpty = function() {
    logger.log('debug', 'Queue|'+this.name+'|isEmpty|len=' + this.queue.length + '|' + this.queue.length === 0);
    return this.queue.length === 0;
};

exports.Queue = Queue;
