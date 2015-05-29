var Joi = require("joi");
var Hapi = require("hapi");
var boom = require("boom");
var path = require("path");
var catapult = require("node-bandwidth");
var config = require("./config.json");
var thenifyAll = require("thenify-all");
var randomstring = require("randomstring");
var fs = require("mz/fs");
var debug = require("debug")("voice");

var server = new Hapi.Server(); //server instance

// configure Catapult API
catapult.Client.globalOptions.userId = config.catapultUserId;
catapult.Client.globalOptions.apiToken = config.catapultApiToken;
catapult.Client.globalOptions.apiSecret = config.catapultApiSecret;
catapult.Client.globalOptions.apiEndPoint = "https://api.stage.catapult.inetwork.com";
//wrap Catapult API functions. Make them thenable (i.e. they will use Promises intead of callbacks)
var Application = thenifyAll(catapult.Application);
var AvailableNumber = thenifyAll(catapult.AvailableNumber);
var PhoneNumber = thenifyAll(catapult.PhoneNumber);
var Domain = thenifyAll(catapult.Domain);
var Call = thenifyAll(catapult.Call);
var Bridge = thenifyAll(catapult.Bridge);
catapult.PhoneNumber.prototype = thenifyAll(catapult.PhoneNumber.prototype);
catapult.Domain.prototype = thenifyAll(catapult.Domain.prototype);
catapult.Call.prototype = thenifyAll(catapult.Call.prototype);
catapult.Bridge.prototype = thenifyAll(catapult.Bridge.prototype);
thenifyAll.withCallback(server, server, ["start", "register"]);


server.connection({ port: process.env.PORT || 3000, host: process.env.HOST || "0.0.0.0" });

// file to store users data
var usersPath = path.join(__dirname, "users.json");

// users data
var users = {};
var domain = null;

// active bridges
var bridges = {};

function saveUsers(){
  return fs.writeFile(usersPath, JSON.stringify(users));
}

function createUser(user){
	return Application.create({
		name: user.userName,
		incomingCallUrl: config.baseUrl + "/users/" + encodeURIComponent(user.userName) + "/callback",
		autoAnswer: false
	})
	.then(function(application){
		user.application = application;
		//search an available number
		return AvailableNumber.searchLocal({state: "NC", quantity: 1});
	})
	.then(function(numbers){
		// and reserve it
		user.phoneNumber = numbers[0].number;
		return PhoneNumber.create({number: user.phoneNumber, applicationId: user.application.id});
	})
	.then(function(){
		//create an endpoint
		return domain.createEndPoint({
			name: "uep-" + randomstring.generate(12),
			description: "Sandbox created Endpoint for user " + user.userName,
			domainId: domain.id,
			applicationId: user.application.id,
			enabled: true,
			credentials: {password: user.password}
		});
	})
	.then(function(endpoint){
		user.endpoint = endpoint;
		//remove 'specific' data to be saved
		delete user.application.client;
		delete user.endpoint.client;
		// save a created user
		users[user.userName] = user;
		return saveUsers();
	});
}

function formatUser(user){
  var k, u = {};
  for(k in user){
    if(k === "password" || k === "application") continue;
    u[k] = user[k];
  }
  return u;
}

// Catapult's event handler
function processEvent(ev, user){
  switch(ev.eventType){
    case "incomingcall":
      var callbackUrl = config.baseUrl + "/users/" + encodeURIComponent(user.userName) + "/callback";
      if(user.phoneNumber === ev.to){
        //incoming call
        debug("Handle incoming call: call to sip %s", user.endpoint.sipUri);
        return Call.create({
          from: user.phoneNumber,
          to: user.endpoint.sipUri,
          callbackUrl: callbackUrl,
          tag: ev.callId
        });
      }
      if(user.endpoint.sipUri.indexOf(ev.from.trim()) >= 0){
        //outgoing call
        debug("Handle outgoing call: call to  %s", ev.to);
        return Call.create({
          from: user.phoneNumber,
          to: ev.to,
          callbackUrl: callbackUrl,
          tag: ev.callId
        });
      }
      break;
    case "answer":
      if(!ev.tag){
        return Promise.resolve();
      }
      return Call.get(ev.tag)
      .then(function(call){
        if(call.bridgeId){
          return Promise.reject();
        }
        return (call.state === "active")?Promise.resolve():call.answerOnIncoming();
      })
      .then(function(){
        //create a bridge for both calls
        return Bridge.create({
          callIds: [ev.callId, ev.tag],
          bridgeAudio: true
        });
      })
      .then(function(bridge){
        bridges[ev.callId] = bridge.id;
        bridges[ev.tag] = bridge.id;
      });
      break;
    case "hangup":
      var bridgeId = bridges[ev.callId];
      if(!bridgeId){
        return Promise.resolve();
      }
      return Bridge.get(bridgeId)
      .then(function(bridge){
        return bridge.getCalls();
      })
      .then(function(calls){
        return Promise.all(calls.map(function(c){
          delete bridges[c.id];
          if(c.state === "active"){
            debug("Hangup another call");
            return c.hangUp();
          }
        }));
      });
      break;
  }
}

// Logs

server.ext("onPreHandler", function(req, reply){
  server.log(["body"], req.method.toUpperCase() + " " + req.url.path + " request data: " + JSON.stringify(req.payload || {}));
  reply.continue();
});


server.ext("onPostHandler", function(req, reply){
  server.log(["body"], req.method.toUpperCase() + " " + req.url.path + " response data: " + JSON.stringify(req.response.source || {}));
  reply.continue();
});

// Routes

//GET /
server.route({
	path: "/",
	method: "GET",
	handler: function(req, reply){
		reply.file('createuser.html');
	}
});

//GET /
server.route({
	path: "/css/{file}",
	method: "GET",
	handler: function(req, reply){
		reply.file('css/'+req.params.file);
	}
});

//GET /
server.route({
	path: "/login",
	method: "post",
	handler: function(req, reply){
		var user = {
			userName : req.payload.userName,
			password : req.payload.userPassword
		};
		createUser(user)
		.then(function(){

		});
		reply("login endpoint: Hi " + req.payload.userName);
	}
	});


//POST /users
server.route({
  path: "/users",
  method: "POST",
  handler: function(req, reply){
    var user = req.payload;
    //create an application for user
	createUser(user)
    .then(function(){
      reply(formatUser(user)).created(config.baseUrl + "/users/" + encodeURIComponent(user.userName));
    })
    .catch(function(err){
      reply(err);
    });
  },
  config: {
    validate:{
      payload: Joi.object().keys({
        userName: Joi.string().required(),
        password: Joi.string().required()
      })
    }
  }
});



//GET /users/{userName}
server.route({
  path: "/users/{userName}",
  method: "GET",
  handler: function(req, reply){
    var user = users[req.params.userName];
    if(user){
      return reply(formatUser(user));
    }
    reply(boom.notFound());
  }
});


//PUT /users/{userName}
server.route({
  path: "/users/{userName}",
  method: "PUT",
  handler: function(req, reply){
    var k, body = req.payload || {};
    var user = users[req.params.userName];
    if(user){
      for(k in body){
        user[k] = body[k];
      }
      return saveUsers().then(function(){
        reply("");
      }, function(err){
        reply(err);
      });
    }
    reply(boom.notFound());
  }
});


//DELETE /users/{userName}
server.route({
  path: "/users/{userName}",
  method: "DELETE",
  handler: function(req, reply){
    var user = users[req.params.userName];
    if(user){
      var phoneNumber = user.phoneNumber;
      delete users[req.params.userName];
      return saveUsers()
      .then(function(){
        return PhoneNumber.get(phoneNumber);
      })
      .then(function(number){
        if(number){
          return number.delete();
        }
      })
      .then(function(){
        reply("");
      }, function(err){
        reply(err);
      });
    }
    reply(boom.notFound());
  }
});


//POST /users/{userName}/callback
server.route({
  path: "/users/{userName}/callback",
  method: "POST",
  handler: function(req, reply){
    var user = users[req.params.userName];
    if(user){
      var ev = req.payload;
      debug(ev);
      processEvent(ev, user).then(function(){
        reply("");
      }, function(err){
        console.error("Callback error:" + err.message);
        reply("");
      });
    }
    reply(boom.notFound());
  }
});

fs.exists(usersPath)
.then(function(exists){
  if(exists){
    debug("Read users data from json file");
    return fs.readFile(usersPath);
  }
  return "{}";
})
.then(function(json){
  debug("Parse users json data");
  users = JSON.parse(json);
  debug("Loaded %d users", Object.keys(users).length);
  return Domain.list();
})
.then(function(domains){
  var dm = domains.filter(function(d){
    return d.name === config.domain;
  })[0];
  if(dm){
    debug("Using existing domain %s", dm.name);
    return dm;
  }
  debug("Creating a domain %s", config.domain);
  return Domain.create({name: config.domain});
})
.then(function(d){
  domain = d;
  return server.register({
    register: require("good"),
    options: {
    opsInterval: 10000,
      reporters: [{
          reporter: require("good-console"),
          events: { log: "*", response: "*", request: "*", error: "*" }
      }]
    }
  });
})
.then(function(){
  debug("Start the server");
  return server.start();
})
.then(function(){
  console.log("Server running at:", server.info.uri);
})
.catch(function(err){
    return console.error(err);
});

