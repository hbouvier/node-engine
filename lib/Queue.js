var winston  = require('winston'),
    logger   = new (winston.Logger)({
        transports: [
            new (winston.transports.Console)({
                                                "level"    : "info",
                                                "json"     : false,
                                                "colorize" : true
            })
        ]                
    }),
    meta     = { 
        "module" : "Queue",
        "pid"    : process.pid
    };

/**
 *  Allocate a new Queue object. The default search function will always return the fist
 *  element pushed into the queue. The defualt execute function will only invoke the
 *  callback (e.g. next) passed to the Queue.execute() function.
 *
 * @param name    To identify this queue when logging
 * @param options To overwrite the "search" and/or "execute" function
 * @constructor
 */

function Queue(name, options) {
    this.name         = name;
    this.queue        = [];
    this.onEvents     = {};
    this.options      = options;
    this.searchFunc   = options && typeof(options.search) === 'function' ?
        options.search :
        function () {
            return true;
        };
    this.executorFunc = options && typeof(options.execute) === 'function' ?
        options.execute :
        function (err, node, next) {
            logger.log('debug', 'Queue::defaultExecutor|node=%s|next=%s', node, next, meta);
            if (typeof(next) === 'function') {
                node = next(err, node);
            }
            return node;
        };
}

/**
 * Add a new node to the queue
 *
 * @param node
 */
Queue.prototype.add = function (node) {
    logger.log('debug', 'Queue|%s|add|node=%s', this.name, node, meta);
    this.queue.push(node);
    this.emit('add', node);
};

/**
 * insert a new node to the queue
 *
 * @param node
 */
Queue.prototype.insert = function (node) {
    logger.log('debug', 'Queue|%s|insert|node=%s', this.name, node, meta);
    this.queue.unshift(node);
    this.emit('insert', node);
};


/**
 *  iterate the queue using the search function, then execute the found node
 *
 * @param key  to use in the search
 * @param next callback passed to the excute function.
 */
Queue.prototype.execute = function (key, next) {
    var node = null;
    
    logger.log('debug', 'Queue|%s|execute|key=%s|next=%s|len=%d', this.name, key, next, this.queue.length, meta);
    if (!key || (typeof(key) === 'function' && !next)) {
        next = !key ? next : key;
        node = this.isEmpty() ? null : this.queue.shift();
        if (node) {
            logger.log('debug', 'Queue|%s|execute|executor|node=%s', this.name, node, meta);
            node = this.executorFunc(null, node, next);
        }
    } else {
        for (var i = 0 ; i < this.queue.length ; ++i) {
            if (this.searchFunc(key, this.queue[i])) {
                node = this.queue[i];
                this.queue.splice(i, 1);
                logger.log('debug', 'Queue|%s|execute|executor|node=%s', this.name, node, meta);
                node = this.executorFunc(null, node, next);
                break;
            }
        }
    }
    if (node) {
        logger.log('debug', 'Queue|%s|execute|re-inserting|node=%s', this.name, node, meta);
        this.queue.unshift(node);
    }
    if (this.isEmpty() === false)
        this.emit('execute', node);
    logger.log('debug', 'Queue|%s|execute|executor|len=%d', this.name, this.queue.length, meta);
};

/**
 *  returns true if the queue is empty
 *
 * @returns {boolean}
 */
Queue.prototype.isEmpty = function() {
    logger.log('debug', 'Queue|%s|isEmpty|len=%d', this.name, this.queue.length, meta);
    return this.queue.length === 0;
};

/**
 * Change the logging transport once a Queue is constructed.
 * @param transports
 * @returns {*}
 */
Queue.prototype.setTransport = function (transports) {
    logger = new (winston.Logger)({
        transports: transports
    });
    return this;
};

/**
 * Add a listener on the possible events for the queue : 'add', 'insert', 
 * 'execute'
 *
 * @param event
 * @param callback
 * @returns {*}
 */
Queue.prototype.on = function (event, callback) {
    if (typeof(event) === 'object') { // Assume array
        for (var i = 0 ; i < event.length ; ++i) {
            this.on(event[i], callback);
        }
        return this;
    }
    if (this.onEvents[event] === undefined) {
        this.onEvents[event] = [];
    }
    this.onEvents[event].push(callback);
    return this;
};

/**
 * emit an event.
 *
 * @param event
 * @param node
 * @returns {*}
 */
Queue.prototype.emit = function (event, node) {
    for (var eventName in this.onEvents) {
        if (this.onEvents.hasOwnProperty(eventName)) {
            for (var cb = 0 ; cb < this.onEvents[eventName].length ; ++cb) {
                this.onEvents[eventName][cb](event, node);
            }
        }
    }
    return this;
};

exports.Queue = Queue;
