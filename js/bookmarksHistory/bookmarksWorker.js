importScripts('../../ext/Dexie.min.js')
importScripts('../../ext/elasticlunr.js/release/elasticlunr.min.js')
importScripts('../util/database.js')

// FNV-1a hash algorithm - code from https://github.com/schwarzkopfb/fnv1a

var fnv1aHash = (function () {
  /**
 * Created by schwarzkopfb on 15/11/17.
 */

  /**
   * FNV-1a hash generation init value.
   * It's exposed, because this allows user to override it.
   *
   * @type {number}
   */
  hash.BASE = 0x811c9dc5

  /**
   * Generates 32 bit FNV-1a hash from the given string.
   * As explained here: http://isthe.com/chongo/tech/comp/fnv/
   *
   * @param s {string} String to generate hash from.
   * @returns {number} The result integer hash.
   */
  function hash (s) {
    var h = hash.BASE

    for (var i = 0, l = s.length; i < l; i++) {
      h ^= s.charCodeAt(i)
      h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)
    }

    return h >>> 0
  }

  return hash
})()

// add bookmarks to the elasticlunr index
var bookmarksIndex = elasticlunr(function () {
  this.pipeline.add(function (token, tokenIndex, tokens) {
    return fnv1aHash(token).toString(16).substring(0, 4)
  })

  this.addField('title')
  this.addField('body')
  this.addField('url')
  this.setRef('id') // url's are used as references
  this.saveDocument(false)
})

/* used to turn refs into bookmarks */

var bookmarksInMemory = {
  /* format is url: bookmarkObject */
}

db.bookmarks.each(function (bookmark) {
  var t1 = performance.now()

  var urlHash = fnv1aHash(bookmark.url).toString(16)

  bookmarksIndex.addDoc({
    id: urlHash,
    title: bookmark.title || '',
    body: bookmark.text || '',
    url: bookmark.url
  })

  var t2 = performance.now()

  /* if (t2 - t1 > 400) {
  	console.info("bookmark is slow", bookmark, bookmark.text.length)
  } */

  bookmarksInMemory[urlHash] = {
    url: bookmark.url,
    title: bookmark.title,
    // we skip the text property, since it takes up a lot of memory and isn't used anywhere
    extraData: bookmark.extraData
  }
}).then(function () {
  console.log('bookmarks loaded in ' + performance.now() + ' ms')
})

onmessage = function (e) {
  var action = e.data.action
  var pageData = e.data.data
  var searchText = e.data.text && e.data.text.toLowerCase()

  if (action === 'addBookmark') {
    db.bookmarks.add({
      url: pageData.url,
      title: pageData.title,
      text: pageData.text,
      extraData: pageData.extraData
    })

    bookmarksIndex.addDoc({
      id: pageData.url,
      title: pageData.title || '',
      body: pageData.text || '',
      url: pageData.url
    })

    bookmarksInMemory[pageData.url] = {
      url: pageData.url,
      title: pageData.title,
      // we skip the text property, since it takes up a lot of memory and isn't used anywhere
      extraData: pageData.extraData
    }
  }

  if (action === 'deleteBookmark') {
    db.bookmarks.where('url').equals(pageData.url).delete()

    delete bookmarksInMemory[pageData.url]
  }

  if (action === 'searchBookmarks') { // do a bookmarks search
    if (!searchText) {
      // convert object to array
      var results = []

      for (var url in bookmarksInMemory) {
        results.push(bookmarksInMemory[url])
      }
      postMessage({
        result: results,
        scope: 'bookmarks',
        callback: e.data.callbackId
      })
      return
    }

    if (searchText.indexOf(' ') === -1) { // if there is only one word, don't do a full-text search
      var results = []
      for (var url in bookmarksInMemory) {
        if ((bookmarksInMemory[url].title + bookmarksInMemory[url].url).toLowerCase().indexOf(searchText.toLowerCase()) !== -1) {
          bookmarksInMemory[url].score = 1
          results.push(bookmarksInMemory[url])
        }
      }
    } else {
      var results = bookmarksIndex.search(searchText, {
        fields: {
          title: {boost: 5},
          url: {boost: 3},
          body: {boost: 1}
        },
        bool: 'AND'
      })

      // return 5, sorted by relevancy

      results = results.sort(function (a, b) {
        return b.score - a.score
      }).splice(0, 5)

      // change data format

      for (var i = 0; i < results.length; i++) {
        var url = results[i].ref

        // the item has been deleted
        if (!bookmarksInMemory[url]) {
          delete results[i]
          continue
        }

        bookmarksInMemory[url].score = results[i].score
        results[i] = bookmarksInMemory[url]
      }
    }

    postMessage({
      result: results,
      scope: 'bookmarks',
      callback: e.data.callbackId
    }) // send back to bookmarks.js
  }
}