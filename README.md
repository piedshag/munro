# munro
a p2p live streaming protocol inspired by [ppspp](https://tools.ietf.org/html/rfc7574) and named after [munro](https://tools.ietf.org/html/rfc7574#section-6.1.2.1). The protocol is completely transport agnostic so it will work wherever you put it. Still a work in progress i need to add some more streams eg. createReadStream()

[![travis](https://travis-ci.org/piedshag/munro.svg?branch=master)](https://travis-ci.org/piedshag/munro)

```
npm install munro
```

## Usage

First someone must create some data

``` js
var munro = require('munro')
var disc = require('discovery-channel')()
var net = require('net')

var mro = munro()
mro.append('hello')
mro.append('world')

var server = net.createServer(function (socket) {
  socket.pipe(mro.peerStream()).pipe(socket)
})

disc.add(mro.id.slice(0, 20), server.address().port)
disc.on('peer', function (hash, peer) {
  var socket = net.connect(peer.port, peer.host)
  socket.pipe(mro.peerStream()).pipe(socket)
})

```

And then someone will consume it

``` js
var munro = require('munro')
var disc = require('discovery-channel')()
var net = require('net')

var mro = munro()

var server = net.createServer(function (socket) {
  socket.pipe(mro.peerStream()).pipe(socket)
})

disc.add(mro.id.slice(0, 20), server.address().port)
disc.on('peer', function (hash, peer) {
  var socket = net.connect(peer.port, peer.host)
  socket.pipe(mro.peerStream()).pipe(socket)
})

mro.get(0, function (err, block) {
  console.log(block.toString()) // 'hello'
})
```

## API

#### `var munro = munro(id)`

create a new munro instance. If id is specified munro will not be able to broadcast pieces and all pieces recieved will be verified using the id.

#### `var stream = munro.peerStream()`

stream is a duplex stream which can be piped to peers in order to replicate data.

#### `munro.broadcast(data)`

munro will sign and broadcast the data to connected peers.

#### `munro.get(index, cb)`

if connected peers have index munro will attempt to download the data.

#### `munro.destroy()`

will destroy all peers and callback error to pending callbacks.

## How does this even work?

Good question. When content is `broadcast` to the network it is only done so in peers look at the example below.
```
   1* // munro hash
 /   \
0     2
```
Two blocks of data are needed to generate a munro hash. Once the hash is generated it is signed off and the peer floods the network with `have` messages. If a peer is interested in the block it sends back a `request` message. The broadcaster then sends back the piece and other pieces that are needed to verify the authenticity so in this case it would send back block `2`. Once the blocks have been recieved the peer is able to verify the authenticity of the content by calculating the munro hash. If all is well that peer then boadcasts `have` messages to all of its peers and the process is repeated. This was inspired by [ppspp](https://tools.ietf.org/html/rfc7574)

-piedshag
