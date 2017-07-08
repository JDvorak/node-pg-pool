'use strict'
const util = require('util')
const EventEmitter = require('events').EventEmitter

const NOOP = function() { }

const Pool = module.exports = function (options, Client) {
  if (!(this instanceof Pool)) {
    return new Pool(options, Client)
  }
  EventEmitter.call(this)
  this.options = Object.assign({}, options)
  this.log = this.options.log || function () { }
  this.Client = this.options.Client || Client || require('pg').Client
  this.Promise = this.options.Promise || global.Promise
  this._clients = []
  this._idle = []
  this._pendingQueue = []
  this._ending = false

  this.options.max = this.options.max || this.options.poolSize || 10
}

util.inherits(Pool, EventEmitter)

Pool.prototype._isFull = function () {
  return this._clients.length >= this.options.max
}

Pool.prototype._pulseQueue = function () {
  // if we don't have any waiting, do nothing
  if (!this._pendingQueue.length) {
    return
  }
  // if we don't have any idle clients and we have no more room do nothing
  if (!this._idle.length && this._isFull()) {
    return
  }
  const waiter = this._pendingQueue.shift()
  if (this._idle.length) {
    const idleItem = this._idle.pop()
    clearTimeout(idleItem.timeoutId)
    return waiter(null, idleItem.client)
  }
  if (!this._isFull()) {
    return this.connect(waiter)
  }
  throw new Error('unexpected condition')
}

Pool.prototype._promisify = function (callback) {
  if (callback) {
    return { callback: callback, result: undefined }
  }
  let reject
  let resolve
  const cb = function (err, client) {
    err ? reject(err) : resolve(client)
  }
  const result = new this.Promise(function (res, rej) {
    resolve = res
    reject = rej
  })
  return { callback: cb, result: result }
}

Pool.prototype._remove = function (client) {
  this._idle = this._idle.filter(item => item.client !== client)
  this._clients = this._clients.filter(c => c !== client)
  client.end()
  this.emit('remove', client)
}

class IdleItem {
  constructor(client, timeoutId) {
    this.client = client
    this.timeoutId = timeoutId
  }
}

function release(client, err) {
  client.release = function () { throw new Error('called release twice') }
  if (err) {
    this._remove(client)
    this._pulseQueue()
    return
  }

  // idle timeout
  let tid = undefined
  if (this.options.idleTimeout) {
    tid = setTimeout(() => {
      this.log('remove idle client')
      this._remove(client)
    }, this.idleTimeout)
  }

  this._idle.push(new IdleItem(client, tid))
  this._pulseQueue()
}

Pool.prototype.connect = function (cb) {
  if (this._ending) {
    const err = new Error('Cannot use a pool after calling end on the pool')
    return cb ? cb(err) : this.Promise.reject(err)
  }
  if (this._clients.length >= this.options.max || this._idle.length) {
    const response = this._promisify(cb)
    const result = response.result
    cb = response.callback
    this._pendingQueue.push((err, client) => {
      if (err) {
        return cb(err, undefined, function () { })
      }
      client.release = release.bind(this, client)
      this.emit('acquire', client)
      cb(err, client, client.release)
    })
    this._pulseQueue()
    return result
  }

  const client = new this.Client(this.options)
  this._clients.push(client)
  const idleListener = (err) => {
    err.client = client
    client.removeListener('error', idleListener)
    client.on('error', () => {
      this.log('additional client error after disconnection due to error', err)
    })
    this._remove(client)
    // TODO - document that once the pool emits an error
    // the client has already been closed & purged and is unusable
    this.emit('error', err, client)
  }

  const response = this._promisify(cb)
  const result = response.result
  cb = response.callback
  this.log('connecting new client')

  // connection timeout logic
  let tid = undefined
  let timeoutHit = false
  if (this.options.connectionTimeout) {
    tid = setTimeout(() => {
      this.log('ending client due to timeout')
      timeoutHit = true
      client.connection.stream.destroy()
    }, this.options.connectionTimeout)
  }

  client.connect((err) => {
    this.log('new client connected')
    if (tid) {
      clearTimeout(tid)
    }
    client.on('error', idleListener)
    if (err) {
      // remove the dead client from our list of clients
      this._clients = this._clients.filter(c => c !== client)
      if (timeoutHit) {
        err.message = 'Connection terminiated due to connection timeout'
      }
      cb(err, undefined, NOOP)
    } else {
      client.release = release.bind(this, client)
      this.emit('connect', client)
      this.emit('acquire', client)
      cb(undefined, client, client.release)
    }
  })
  return result
}

Pool.prototype.query = function (text, values, cb) {
  if (typeof values === 'function') {
    cb = values
    values = undefined
  }
  const response = this._promisify(cb)
  cb = response.callback
  this.connect(function (err, client) {
    if (err) {
      return cb(err)
    }
    client.query(text, values, function (err, res) {
      client.release(err)
      if (err) {
        return cb(err)
      } else {
        return cb(undefined, res)
      }
    })
  })
  return response.result
}

Pool.prototype.end = function (cb) {
  if (this._ending) {
    const err = new Error('Called end on pool more than once')
    return cb ? cb(err) : this.Promise.reject(err)
  }
  this._ending = true
  const promises = this._clients.map(client => client.end())
  if (!cb) {
    return this.Promise.all(promises)
  }
  this.Promise.all(promises)
    .then(() => cb ? cb() : undefined)
    .catch(err => {
      cb(err)
    })
}

Object.defineProperty(Pool.prototype, 'waitingCount', {
  get: function () {
    return this._pendingQueue.length
  }
})

Object.defineProperty(Pool.prototype, 'idleCount', {
  get: function () {
    return this._idle.length
  }
})

Object.defineProperty(Pool.prototype, 'totalCount', {
  get: function () {
    return this._clients.length
  }
})
