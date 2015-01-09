const fs = require('fs');
const express = require('express');
const session = require('cookie-session');
const bodyParser = require('body-parser');
const React = require('react');
const nconf = require('nconf');
const oauth = require('oauth');
const handlebars = require('handlebars');

const t = require('transducers.js');
const { range, seq, compose, map, filter } = t;
const { go, chan, take, put, operations: ops } = require('src/lib/csp');
const { Element, Elements } = require('src/lib/react-util');
const { takeAll } = require('src/lib/chan-util');
const { encodeTextContent } = require('src/lib/util');
const routes = require('src/routes');
const Router = require('react-router');
const api = require('./impl/api');
const feed = require('./feed');
const statics = require('./impl/statics');

nconf.argv().env('_').file({
  file: __dirname + '/../config/config.json'
}).defaults({
  'admins': []
});

let app = express();
app.use(express.static(__dirname + '/../static'));
app.use(session({ keys: ['foo'] }));
app.use(bodyParser.json());

if(process.env.NODE_ENV === 'production') {
  app.use(function(err, req, res, next) {
    console.log(err);
  });
}

// util

// Similar to str.replace, but doesn't treat any characters like $
// specially. The result will always have the raw version of `newsub`.
function rawReplace(str, sub, newsub) {
  let idx = str.indexOf(sub);
  if(idx !== -1) {
    return str.slice(0, idx) +
      newsub +
      str.slice(idx + sub.length);
  }
  return str;
}

// middleware

function isAdmin(username) {
  return app.testing || nconf.get('admins').indexOf(username) !== -1;
}

function requireAdmin(req, res, next) {
  let username = req.session.username;

  if(app.testing || (username && isAdmin(username))) {
    next();
  }
  else {
    res.status(401).render('bad auth, man');
  }
}

// api routes

function send(res, ch) {
  go(function*() {
    try {
      let obj = yield take(ch);
      res.set('Content-Type', 'application/json');
      res.send(JSON.stringify(obj));
    }
    catch(e) {
      res.status(500).send(e.message);
    }
  });
}

function sendOk(res, ch) {
  go(function*() {
    try {
      yield take(ch);
      res.send('ok');
    }
    catch(e) {
      res.send(500, e.message);
    }
  });
}

app.get('/api/posts', function(req, res) {
  let query = JSON.parse(req.query.query);
  send(res, api.queryPosts(query));
});

app.get('/api/drafts', requireAdmin, function(req, res) {
  let query = JSON.parse(req.query.query);
  send(res, api.queryDrafts(query));
});

app.get('/api/post', function(req, res) {
  send(res, api.getPost(req.query.shorturl));
});

app.post('/api/delete/:post', requireAdmin, function(req, res) {
  sendOk(res, api.deletePost(req.params.post));
});

app.post('/api/post/:post', function(req, res) {
  sendOk(res, api.updatePost(req.params.post, req.body));
});

app.post('/api/post', function(req, res) {
  sendOk(res, api.savePost(req.body));
});

// login

let oauthManager = new oauth.OAuth(
  'https://api.twitter.com/oauth/request_token',
  'https://api.twitter.com/oauth/access_token',
  nconf.get('twitter:app_key'),
  nconf.get('twitter:app_secret'),
  '1.0A',
  nconf.get('url') + '/login-callback',
  'HMAC-SHA1'
);

app.get('/login', function(req, res) {
  oauthManager.getOAuthRequestToken(function(err, token, secret, results) {
    if(err) {
      res.send('error getting request token: ' + err);
    }
    else {
      req.session.oauth_token = token;
      req.session.oauth_secret = secret;
      res.redirect('https://twitter.com/oauth/authenticate?oauth_token=' + token);
    }
  });
});

app.get('/login-callback', function(req, res) {
  req.session.oauth_verifier = req.query.oauth_verifier;

  oauthManager.getOAuthAccessToken(
    req.session.oauth_token,
    req.session.oauth_secret,
    req.session.oauth_verifier,
    function(err, accessToken, accessSecret, results) {
      if(err) {
        res.send('error getting access token: ' + err);
      }
      else {
        req.session.username = results.screen_name;
        res.redirect('/');
      }
    }
  );
});

// catch-all 404

app.get('/api/*', function(req, res) {
  res.send('bad API request');
});

// page handler

app.get('/atom.xml', function(req, res) {
  go(function*() {
    let posts = yield api.getPosts(5);
    res.set('Content-Type', 'application/atom+xml');
    res.send(feed.render(posts));
  });
});

app.get('*', function(req, res, next) {
  Router.run(routes, req.path, (Handler, state) => {
    go(function*() {
      let props = {};

      // Call the `fetchData` method on each component that defines it
      // and load in data before rendering
      let requests = seq(state.routes, compose(
        filter(x => x.handler.fetchData),
        map(x => {
          return {
            name: x.name,
            request: x.handler.fetchData(
              api,
              state.params,
              isAdmin(req.session.username)
            )
          };
        }),
        filter(x => !!x.request)
      ));

      // transducers should implement zip, keys, and values
      props.data = {};
      for(let i in requests) {
        let request = requests[i];
        try {
          props.data[request.name] = yield take(request.request);
        }
        catch(e) {
          next(e);
          return;
        }
      }

      let route = state.routes[state.routes.length - 1];
      if(route.handler.bodyClass) {
        props.bodyClass = route.handler.bodyClass;
      }

      props.username = req.session.username;
      props.isAdmin = isAdmin(props.username);
      props.routeState = state;
      props.params = state.params;

      let content = rawReplace(
        statics.baseHTML,
        '{{ MOUNT_CONTENT }}',
        React.renderToString(React.createElement(Handler, props))
      );

      let payload = {
        data: props.data,
        username: props.username,
        isAdmin: props.isAdmin,
        config: {
          url: nconf.get('url')
        }
      };

      content = rawReplace(
        content,
        '{{ PAYLOAD }}',
        encodeTextContent(JSON.stringify(payload))
      );

      res.send(content);
    });
  });
});

module.exports = app;