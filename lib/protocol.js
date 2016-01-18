var lpstream = require('length-prefixed-stream')
var duplexify = require('duplexify')
var util = require('util')
var crypto = require('crypto')
var bencode = require('bencode')
var bufferEquals = require('buffer-equals')

var PROTOCOL = new Buffer('munro')

module.exports = Protocol

function Protocol (opts) {
  var self = this
  if (!(this instanceof Protocol)) return new Protocol(opts)
  if (!opts) opts = {}

  self._encode = lpstream.encode()
  self._decode = lpstream.decode({limit: 5 * 1024 * 1024})
  self._requests = []
  self._handshook = false
  self.destroyed = false

  self.id = crypto.randomBytes(32)
  self.remoteId = null
  self.inflight = 0

  var handshake = {
    protocol: 'munro',
    discard: opts.discard || 20, // number of blocks we keep in memory
    id: opts.id
  }

  self._send(0, handshake)

  duplexify.call(self, self._decode, self._encode)

  self._decode.on('data', function (data) {
    self._parse(data)
  })
}

util.inherits(Protocol, duplexify)

Protocol.prototype.destroy = function (err) {
  if (this.destroyed) return
  this.destroyed = true

  while (this._requests.length) {
    var cb = this._requests.shift()
    if (cb) cb(err)
  }

  if (err) this.emit('error', err)
  this.emit('close')
}

Protocol.prototype._parse = function (data) {
  var self = this
  if (self.destroyed) return

  var slice = data.slice(1, data.length)

  if (!self._handshook) {
    try {
      var handshake = bencode.decode(slice)
    } catch (err) {
      return self.destroy(err)
    }
    self._handshook = true
    self._onhandshake(handshake)
    return
  }

  var type = data[0]

  try {
    var message = bencode.decode(slice)
  } catch (err) {
    return self.destroy(err)
  }

  switch (type) {
    case 1: return self._onhave(message)
    case 2: return self._onrequest(message)
    case 3: return self._onresponse(message)
  }

  this.emit('unknown', data)
}

Protocol.prototype._onhandshake = function (data) {
  var self = this
  if (!bufferEquals(data.protocol, PROTOCOL)) return self.destroy(new Error('Must be using munro'))
  self.remoteId = data.id
  self.emit('handshake', data)
}

Protocol.prototype._onhave = function (data) {
  var self = this
  self.emit('have', data)
}

Protocol.prototype._onrequest = function (data) {
  var self = this
  self.emit('request', data)
}

Protocol.prototype._onresponse = function (data) {
  var self = this
  if (self._requests.length > data.id) {
    var cb = self._requests[data.id]
    self._requests[data.id] = null
    while (self._requests.length && !self._requests[self._requests.length - 1]) self._requests.pop()
    if (cb) cb(null, data)
  }
  self.emit('response', data)
}

Protocol.prototype.have = function (have) {
  this._send(1, have)
}

Protocol.prototype.request = function (req, cb) {
  req.id = this._requests.indexOf(null)
  if (req.id === -1) req.id = this._requests.push(null) - 1
  this._requests[req.id] = cb
  this._send(2, req)
}

Protocol.prototype.response = function (res) {
  this._send(3, res)
}

Protocol.prototype._send = function (type, data) {
  var self = this
  var buf = bencode.encode(data)
  var msg = new Buffer(buf.length + 1)
  msg[0] = type
  buf.copy(msg, 1)
  self._encode.write(msg)
}
