var sys   = require("sys"),
    stdin = process.openStdin(),
    cluster = require('cluster');

process.send({
        "action"     : "listening",
        "id"         : cluster.worker.id,
        "origin"     : 'worker'
    });
console.log("type something: ");
stdin.addListener("data", function(d) {
    // note:  d is an object, and when converted to a string it will
    // end with a linefeed.  so we (rather crudely) account for that  
    // with toString() and then substring() 
    console.log("you entered: [" + 
        d.toString().substring(0, d.length-1) + "]");
        console.log("type something: ");
  });
