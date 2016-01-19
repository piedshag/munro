var flat = require('flat-tree')
var crypto = require('crypto')
var util = require('util')
var events = require('events')
var signatures = require('sodium-signatures')
var bufferEquals = require('buffer-equals')
var eos = require('end-of-stream')
var bitfield = require('bitfield')
var debug = require('debug')('munro')
var stream = require('stream')

var protocol = require('./lib/protocol')

module.exports = Munro

var DEFAULT_BITFIELD = {grow: Infinity}

function Munro (id, opts) {
  var self = this
  if (!(self instanceof Munro)) return new Munro(id, opts)
  if (!opts) opts = {}

  self.keypair = id ? {publicKey: id} : signatures.keyPair()
  self.id = self.keypair.publicKey

  self.blocks = []
  self.signatures = []
  self.peers = []
  self.pending = []
  self.discard = opts.discard || 20

  self.head = -1
  self.streaming = false
  self.streamhead = -1

  events.EventEmitter.call(self)
}

util.inherits(Munro, events.EventEmitter)

Munro.prototype.broadcast = function (data) {
  var self = this
  if (!self.keypair.secretKey) throw new Error('must have a private key to sign data')
  if (!Buffer.isBuffer(data)) data = new Buffer(data)

  var index = self.blocks.length
  var treeIndex = flat.index(0, index)

  self.blocks[index] = data

  // generate munro hash if two children

  if (index % 2) {
    var parent = flat.parent(treeIndex)
    var children = flat.children(parent)

    var hash = createHash()
    for (var i = 0; i < children.length; i++) {
      var child = flat.offset(children[i])
      hash.update(self.blocks[child])
    }
    var digest = hash.digest()

    var signature = signatures.sign(digest, self.keypair.secretKey)
    self.signatures[flat.parent(treeIndex)] = signature

    for (var n = 0; n < 2; n++) {
      self.have(index - n)
    }
  }
}

Munro.prototype.have = function (block) {
  var self = this
  for (var i = 0; i < self.peers.length; i++) {
    self.peers[i].have({ index: block })
  }
  if (block > self.head) self.head = block
  if (self.head > self.discard) self.blocks = self.blocks.slice(self.head - self.discard, self.head)
}

Munro.prototype.get = function (index, cb) {
  var self = this
  if (!cb) cb = noop

  if (self.blocks[index]) return cb(null, self.blocks[index])
  var available = self._getpeers(index)
  if (available === -1) {
    self.pending.push([index, cb])
    return
  }

  var peer = self.peers[available]
  peer.request({ index: index }, function (err, data) {
    if (err) return cb(err, null)
    self._verify(data, cb)
  })
}

Munro.prototype.peerStream = function () {
  var self = this
  var stream = protocol({ id: self.id, discard: self.discard })

  debug('new peer stream')

  eos(stream, function () {
    var i = self.peers.indexOf(stream)
    if (i > -1) self.peers.splice(i, 1)
  })

  stream.on('handshake', function (data) {
    if (!bufferEquals(data.id, self.id)) return stream.destroy('must have the same id')
    self.peers.push(stream)

    stream.discard = data.discard
    stream.blocks = bitfield(1, DEFAULT_BITFIELD)
    if (!self.blocks.length) return
    for (var i = 0; i < self.blocks.length; i++) {
      stream.have({ index: i })
    }
  })

  stream.on('have', function (data) {
    debug('updating stream head to ' + data.index)

    if (data.index > self.available) self.available = data.index
    if (data.index > stream.head) stream.head = data.index

    stream.blocks.set(data.index)
    self.update(data.index)
  })

  stream.on('request', function (data) {
    var treeIndex = flat.index(0, data.index)
    var signature = self.signatures[flat.parent(treeIndex)]
    var sibling = flat.offset(flat.sibling(treeIndex))

    if (!signature && !self.blocks[sibling]) return

    stream.response({
      id: data.id,
      index: data.index,
      proof: [signature, self.blocks[sibling]],
      block: self.blocks[data.index]
    })

    self.emit('upload', data.index, self.blocks[data.index])
  })

  return stream
}

Munro.prototype._getpeers = function (index) {
  var self = this
  var selected = -1
  var found = 1
  for (var i = 0; i < self.peers.length; i++) {
    var p = self.peers[i]
    if (p && p.blocks && p.blocks.get(index)) {
      if (Math.random() < (1 / found++)) selected = i
    }
  }
  return selected
}

Munro.prototype._updatestream = function (index) {
  var self = this
  if (index !== self.streamhead + 1) return // ensure blocks are in proper order
  self.streamhead = self.streamhead + 1

  self.get(index, function (err, block) {
    if (err) return self.stream.push(null)
    self.stream.push(block.data)
  })
}

Munro.prototype._verify = function (data, cb) {
  var self = this

  var signature = data.proof[0]
  var other = data.proof[1]
  var hash = null

  var treeIndex = flat.index(0, data.index)
  var children = flat.children(flat.parent(treeIndex))

  if (children[1] === treeIndex) hash = createHash().update(other).update(data.block).digest()
  if (children[0] === treeIndex) hash = createHash().update(data.block).update(other).digest()
  var verified = signatures.verify(hash, signature, self.id)

  if (!verified) return debug('unable to verify block ' + data.index)
  debug('verified block number ' + data.index)
  self.blocks[data.index] = data.block
  self.signatures[flat.parent(data.index)] = signature

  self.emit('download', data.index, data.block)

  self.head = data.index

  cb(null, {data: data.block, index: data.index})
}

Munro.prototype.update = function (number) {
  var self = this
  if (self.streaming) self._updatestream(number)

  for (var i = 0; i < self.pending.length; i++) {
    var index = self.pending[i][0]
    var cb = self.pending[i][1]

    var p = self._getpeers(index)
    if (p === -1) return
    self.pending.splice(i, 1)
    self.get(index, cb)
  }
}

Munro.prototype.writeStream = function () {
  var self = this
  debug('new write stream created')
  var ws = stream.Writable()
  ws._write = function (chunk, enc, next) {
    self.broadcast(chunk)
    next()
  }
  return ws
}

Munro.prototype.readStream = function () {
  var self = this
  debug('new read stream created')
  self.streaming = true
  var rs = stream.Readable()
  rs._read = function () {}
  self.stream = rs
  return rs
}

Munro.prototype.destroy = function (err) {
  var self = this
  for (var i = 0; i < self.peers.length; i++) {
    self.peers[i].destroy(err)
  }
}

function createHash () {
  return crypto.createHash('sha256')
}

function noop () {}
