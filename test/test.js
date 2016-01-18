var tape = require('tape')
var munro = require('../')

tape('test get block', function (t) {
  var test = munro()
  var test1 = munro(test.id)
  var stream = test1.peerStream()

  stream.pipe(test.peerStream()).pipe(stream)

  test.broadcast('hello')
  test.broadcast('my')

  test1.get(0, function (err, block) {
    if (err) t.end(err)
    t.same(new Buffer('hello'), block)
    t.end()
  })
})

tape('writeable stream', function (t) {
  var test = munro()
  var test1 = munro(test.id)
  var stream = test1.peerStream()

  stream.pipe(test.peerStream()).pipe(stream)

  var ws = test.writeStream()
  ws.write('yo')
  ws.write('my')
  ws.write('name')
  ws.write('is')

  test1.get(3, function (err, block) {
    if (err) t.end(err)
    t.same(block, new Buffer('is'))
    t.end()
  })
})
