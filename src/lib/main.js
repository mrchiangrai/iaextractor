﻿/** Require **/
var {Cc, Ci, Cu}  = require('chrome'),
    {Hotkey}      = require("sdk/hotkeys"),
    tabs          = require("sdk/tabs"),
    self          = require("sdk/self"),
    timer         = require("sdk/timers"),
    sp            = require("sdk/simple-prefs"),
    panel         = require("sdk/panel"),
    _             = require("sdk/l10n").get,
    pageMod       = require("sdk/page-mod"),
    Request       = require("sdk/request").Request,
    toolbarbutton = require("./toolbarbutton"),
    userstyles    = require("./userstyles"),
    youtube       = require("./youtube"),
    subtitle      = require("./subtitle"),
    download      = require("./download"),
    extract       = require("./extract"),
    ffmpeg        = require("./ffmpeg"),
    tools         = require("./misc"),
    data          = self.data,
    prefs         = sp.prefs,
    fileSize      = tools.fileSize,
    format        = tools.format,
    _prefs        = tools.prefs,
    prompts       = tools.prompts,
    prompts2      = tools.prompts2,
    update        = tools.update,
    windows          = {
      get active () { // Chrome window
        return require('sdk/window/utils').getMostRecentBrowserWindow()
      }
    };

Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");

/** Load style **/
userstyles.load(data.url("overlay.css"));

/** Check server status for signature updating **/
Request({
  url: "http://add0n.com/signature2.php?stat=reset",
  onComplete: function (response) {
    if (response.status == 200 && response.text == "y") {  //Reset old signatures
      prefs.player = "";
      prefs.ccode = "";
    }
  }
}).get();

/** Internal configurations **/
var config = {
  //URLs
  urls: {
    youtube: "https://www.youtube.com/",
    tools: "chrome://iaextractor/content/tools.xul",
    homepage: "http://add0n.com/extractor.html",
    update: "http://add0n.com/extractor-updated.html",
    flashgot: "https://addons.mozilla.org/firefox/addon/flashgot/",
    downthemall: "https://addons.mozilla.org/firefox/addon/downthemall/",
    instruction: "http://add0n.com/extractor.html#instruction"
  },
  //toolbar
  toolbar: {
    id: "youtube-audio-converter",
    move: {
      toolbarID: "nav-bar", 
      get insertbefore () {
        var id = prefs.nextSibling;
        return id ? id : "home-button"
      },
      forceMove: false
    }
  },
  //Timing
  desktopNotification: 3, //seconds
  noAudioExtraction: 4,
  //Tooltip
  tooltip: _("name") + "\n\n" + _("tooltip1") + "\n" + _("tooltip2"),
  //Panels
  panels: {
    rPanel: {
      width: 300,
      height: 230
    },
    iPanel: {
      width: 520,
      height: 520
    }
  }
}

var iPanel, rPanel, cmds, yButton, IDExtractor, welcome;

/** Inject menu and button into YouTube pages **/
pageMod.PageMod({
  include: ["*.youtube.com"],
  contentScriptFile: data.url("formats/permanent.js"),
  contentStyleFile: data.url("formats/permanent.css"),
  onAttach: function(worker) {
    worker.port.on("formats", function() {
      cmds.onShiftClick();
    });
    worker.port.on("page-update", function() {
      monitor();
    });
  }
});

/** Toolbar Panel **/
rPanel = panel.Panel({
  width: config.panels.rPanel.width,
  height: config.panels.rPanel.height,
  contentURL: data.url('report.html'),
  contentScriptFile: data.url('report/report.js'),
  contentScriptWhen: "ready"
});
rPanel.port.on("cmd", function (cmd) {
  switch (cmd) {
  case "download":
    cmds.onCommand(null, null, true, null);
    break;
  case "show-download-manager":
    download.show();
    break;
  case "formats":
    rPanel.hide();
    cmds.onShiftClick();
    break;
  case "embed":
    cmds.onCtrlClick();
    break;
  case "destination":
    prefs.dFolder = parseInt(arguments[1]);
    break;
  case "quality":
    prefs.quality = parseInt(arguments[1]);
    break;
  case "format":
    prefs.extension = parseInt(arguments[1]);
    break;
  case "do-extract":
    prefs.doExtract = arguments[1];
    break;
  case "do-subtitle":
    prefs.doSubtitle = arguments[1];
    break;
  case "do-size":
    prefs.getFileSize = arguments[1];
    break;
  case "tools":
    rPanel.hide();
    windows.active.open(
      config.urls.tools, 
      'iaextractor', 
      'chrome,minimizable=yes,all,resizable=yes'
    );
    break;
  case "cancel":
    listener.cancel(parseInt(arguments[1]));
    break;
  case "settings":
    windows.active.BrowserOpenAddonsMgr(
      "addons://detail/" + encodeURIComponent("feca4b87-3be4-43da-a1b1-137c24220968@jetpack"))
    rPanel.hide();
    break;
  }
});
rPanel.on("show", function() {
  rPanel.port.emit(
    "update", 
    prefs.doExtract, 
    prefs.doSubtitle, 
    prefs.getFileSize, 
    prefs.dFolder, 
    prefs.quality, 
    prefs.extension, 
    yButton.saturate
  );
});

/** Get video id from URL **/
IDExtractor = (function () {
  var urls = [], IDs = [];
  function cache(url, id) {
    var index = urls.push(url) - 1;
    IDs[index] = id;
  }
  
  return function (url, callback, pointer) {
    //Cache XMLHttpRequest of non YouTube pages
    if (typeof(url) == "object" && url.origin) {
      var obj = url;
      var index = urls.indexOf(obj.origin);
      if (index == -1) {
        index = urls.push(obj.origin) - 1;
      }
      if (!IDs[index]) {
        IDs[index] = [];
      }
      IDs[index].push(obj);
      
      return;
    }
    //Is it in the cache?
    var index = urls.indexOf(url);
    if (index !== -1 && IDs[index]) {
      return callback.apply(pointer, [IDs[index]]);
    }
    var id;
    //Watch page
    var temp = /http.*:.*youtube.com\/watch\?.*v\=([^\=\&]*)/.exec(url);
    id = temp ? temp[1]: null;
    if (callback && id) {
      cache(url, id);
      return callback.apply(pointer, [id]);
    }
    //Rest
    function fetchId (script) {
      var worker = tabs.activeTab.attach({
        contentScript: "self.port.emit('response', (%s)())".replace("%s", script)
      });
      worker.port.on("response", function (id) {
        if (callback) {
          cache(url, id);
          worker.destroy();
          return callback.apply(pointer, [id]);
        }
      });
    }
    //User page
    if (/http.*:.*youtube.com\/user/.test(url)) {
      var tmp = function () {
        try {
          var players = document.getElementsByTagName("embed"); // Flash player
          if (players.length) {
            var flashvars = players[0].getAttribute("flashvars");
            if (!flashvars) return null;
            var id = /\&video_id=([^\&]*)/.exec(flashvars);
            if (id && id.length) {
              return id[1];
            }
            return null;
          }
          else {  //HTML5 player
            var videos = document.getElementsByTagName("video");
            if (!videos || !videos.length) return null;
            return videos[0].getAttribute("data-youtube-id");
          }
        }
        catch(e) {
          return null
        }
      }
      fetchId(tmp + "");
    }
    //movie
    else if (/http.*:.*youtube.com\/movie/.test(url)) {
      var tmp = function () {
        try {
          var divs = document.getElementsByClassName('ux-thumb-wrap');
          return divs.length ? /v\=([^\=\&]*)/.exec(divs[0].getAttribute('href'))[1] : null
        }
        catch(e) {
          return null
        }
      }
      fetchId(tmp + "");
    }
    //Other YouTube pages
    else if (/http.*:.*youtube.com/.test(url)) {
      var tmp = function () {
        try {
          var embed = document.getElementsByTagName("embed")[0];
          var str = decodeURIComponent(embed.getAttribute("flashvars"));
          var id = /video\_id\=([^\&]*)/.exec(str);
          return id[1];
        }
        catch (e) {}
        try {
          var video = document.getElementsByTagName("video")[0];
          return video.getAttribute("data-youtube-id");
        }
        catch (e) {}
        
        return null
      }
      fetchId(tmp + "");
    }
    else {
      return callback.apply(pointer, [null]);
    }
  }
})();

/** Initialize **/
cmds = {
  /**
   * onCommand
   * 
   * @param {Event} mouse event.
   * @param {Object} Toolbar button object, used to detect the position of panel.
   * @param {Boolean} auto start download after link detection
   * @param {Number} index of YouTube link in vInfo object
   * 
   * no return output
   */
  onCommand: function (e, tbb, download, fIndex) {
    if (tbb) {
      if (!prefs.oneClickDownload || !prefs.silentOneClickDownload) {
        rPanel.show(tbb);
      }
      if (prefs.oneClickDownload) {
        download = true;
      }
      else {
        return;
      }
    }
    let url = tabs.activeTab.url;
    IDExtractor(url, function (videoID) {
      if (download && videoID) {
        new getVideo(videoID, listener, fIndex);
      }
      else {
        tabs.open(config.urls.youtube);
        rPanel.hide();
      }
    });
  },
  onMiddleClick: function (e, tbb) {
    if (!iPanel) {  //Do not load it on initialization
      iPanel = panel.Panel({
        width: config.panels.iPanel.width,
        height: config.panels.iPanel.height,
        contentURL: data.url('info.html'),
        contentScriptFile: [
          data.url('info/jsoneditor/jsoneditor.js'), 
          data.url('info/info.js')
        ],
        contentScriptWhen: "ready"
      });
    }
    IDExtractor(tabs.activeTab.url, function (videoID) {
      if (!videoID) return;
      iPanel.show(tbb);
      youtube.getInfo(videoID, function (vInfo, e) {
        iPanel.port.emit('info', vInfo);
      });
    });
  },
  onCtrlClick: function () {
    var script = function () {
      var reg = /embed\/([^\=\&\'\"\\\/\_\-\<\>]{5,})/g, arr = [], test;
      while ((test = reg.exec(document.body.innerHTML)) !== null) {
        arr.push(test[1]);
      }
      reg = /watch\?.*v\=([^\=\&\'\"\\\/\_\-\<\>]{5,})/g;
      while ((test = reg.exec(document.body.innerHTML)) !== null) {
        arr.push(test[1]);
      }
      return arr
    }
    let worker = tabs.activeTab.attach({
      contentScript: "self.port.emit('response', (%s)())".replace("%s", script + "")
    });
    worker.port.on("response", function (arr) {
      if (arr) {
        if (arr && arr.length) {
          arr = arr.filter(function(elem, pos) {
              return arr.indexOf(elem) == pos;
          });
          var obj = prompts(_("prompt1"), _("prompt2"), arr);
          if (obj[0] && obj[1] != -1) {
            tabs.open(config.urls.youtube + "watch?v=" + arr[obj[1]]);
          }
        }
        else {
          notify(_("name"), _("msg4"));
        }
      }
    });
  },
  onShiftClick: function () {
    let url = tabs.activeTab.url;
    IDExtractor(url, function (videoID) {
        if (videoID) {
        let worker = tabs.activeTab.attach({
          contentScriptFile: data.url("formats/inject.js"),
          contentScriptOptions: {
            doSize: prefs.getFileSize
          }
        });
        worker.port.on("file-size-request", function (url, i1, i2) {
          fileSize(url, function (url, size) {
            worker.port.emit("file-size-response", url, size, i1, i2);
          });
        });
        worker.port.on("download", function (fIndex) {
          // Show instruction
          if (!prefs.showInstruction) {
            var tmp = prompts2(_("msg17"), _("msg18"), _("msg19"), _("msg20"), _("msg21"), true);
            prefs.showInstruction = tmp.check.value;
            if (tmp.button == 1) {
              timer.setTimeout(function () {
                tabs.open("http://add0n.com/extractor.html#instruction");
              }, 1000);
            }
          }
          cmds.onCommand(null, null, true, fIndex);
        });
        youtube.getInfo(videoID, function (vInfo) {
          worker.port.emit('info', vInfo);
        });
        worker.port.on("flashgot", flashgot);
        worker.port.on("downThemAll", downThemAll); 
        worker.port.on("error", function(code) {
          notify(_("name"), _(code));
        });
      }
      else {
        notify(_('name'), _('msg4'));
      }
    });
  }
}

yButton = toolbarbutton.ToolbarButton({
  id: config.toolbar.id,
  label: _("toolbar"),
  tooltiptext: config.tooltip,
  panel: rPanel,
  onCommand: cmds.onCommand,
  onClick: function (e, tbb) { //Linux problem for onClick
    if (e.button == 1) {
      cmds.onMiddleClick (e, tbb);
    }
    if (e.button == 0 && e.ctrlKey) {
      e.stopPropagation();
      e.preventDefault();
      cmds.onCtrlClick();
    }
    if (e.button == 0 && e.shiftKey) {
      e.stopPropagation();
      e.preventDefault();
      cmds.onShiftClick(e);
    }
  }
});

exports.main = function(options, callbacks) {
  //Install
  if (options.loadReason == "install" || prefs.forceVisible) {
    //If adjacent button is restartless wait for its creation
    timer.setTimeout(function (){
      yButton.moveTo(config.toolbar.move);
    }, 800);
  }
  hotkey.initialization().register();
  // Check current page
  monitor(tabs.activeTab);
  //Welcome page
  if (options.loadReason == "upgrade" || options.loadReason == "install") {
    prefs.newVer = options.loadReason;
  }
  if (options.loadReason == "startup" || options.loadReason == "install") {
    welcome();
  }
  //if (options.loadReason == "install" && !prefs.ffmpegPath) {
  //  windows.active.alert (_("msg24"));
  //}
  //Reload about:addons to set new observer.
  for each (var tab in tabs) {
    if (tab.url == "about:addons") {
      tab.reload();
    }
  }
}

/** Welcome page **/
welcome = function () {
  if (!prefs.newVer) return;
  if (prefs.welcome) {
    timer.setTimeout(function () {
      tabs.open({
        url: (prefs.newVer == "install" ? config.urls.homepage : config.urls.update) + "?v=" + self.version, 
        inBackground : false
      });
      prefs.newVer = "";
    }, 3000);
  }
  else {
    prefs.newVer = "";
  }
}

/** Monitor **/
function monitor () {
  IDExtractor(tabs.activeTab.url, function (videoID) {
    if (videoID) {
      yButton.saturate = 1;
    }
    else {
      yButton.saturate = 0;
    }
  });
}
tabs.on('ready', function () {
  //Even when document is ready, most likely the player is not accessible.
  timer.setTimeout(monitor, 2000);
});
tabs.on('activate', monitor);

/** Store toolbar button position **/
var aftercustomizationListener = function () {
  let button = windows.active.document.getElementById(config.toolbar.id);
  if (!button) return;
  prefs.nextSibling = button.nextSibling.id;
}
windows.active.addEventListener("aftercustomization", aftercustomizationListener, false); 
exports.onUnload = function (reason) {
  //Remove toolbar listener
  windows.active.removeEventListener("aftercustomization", aftercustomizationListener, false); 
  //Close tools window
  let wm = Cc["@mozilla.org/appshell/window-mediator;1"]
    .getService(Ci.nsIWindowMediator);   
  let enumerator = wm.getEnumerator("iaextractor:tools");
  while (enumerator.hasMoreElements()) {
    let win = enumerator.getNext();
    win.close();
  }
  //Remove observer
  hotkey.destroy();
  //http.destroy();
}

/** Hotkeys **/
var hotkey = {
  _key: null,
  initialization: function () {
    Services.obs.addObserver(hotkey.observer, "addon-options-displayed", false);
    //
    sp.on("downloadHKey", function () {
      if (hotkey._key) {
        hotkey._key.destroy();
      }
      hotkey.register();
    });
    return this;
  },
  register: function () {
    if (prefs.downloadHKey.split("+").length == 1 || !prefs.downloadHKey) {
      return;
    }
    var key = prefs.downloadHKey.replace(/\ \+\ /g, "-").toLowerCase();
    key = key.split("-");
    key[key.length - 1] = key[key.length - 1][0];
    key = key.join("-");
    this._key = Hotkey({
      combo: key,
      onPress: function() {
        cmds.onCommand(null, null, true, null);
      }
    });
  },
  observer: {
    observe: function(doc, aTopic, aData) {
      if (aTopic == "addon-options-displayed" && aData == self.id) {
        var list = doc.getElementsByTagName("setting");
        list = Array.prototype.slice.call(list);
        list = list.filter(function (elem) {
          return elem.getAttribute("pref-name") == "downloadHKey"
        });
        var textbox = list[0];
        textbox.setAttribute("readonly", true);
        textbox.addEventListener("keydown", hotkey.listen);
        hotkey.textbox = textbox;
      }
    }
  },
  listen: function (e) {
    e.stopPropagation();
    e.preventDefault();
    var comb = [];
    prefs.downloadHKey = "";  //Fire listener
    if ((e.ctrlKey || e.shiftKey || e.altKey) && (e.keyCode >= 65 && e.keyCode <=90)) {
      if (e.ctrlKey) comb.push("Accel");
      if (e.shiftKey) comb.push("Shift");
      if (e.altKey) comb.push("Alt");
      comb.push(String.fromCharCode(e.keyCode));
      prefs.downloadHKey = comb.join(" + ");
    }
    else {
      hotkey.textbox.value = _("err8");
      if (hotkey._key) {
        hotkey._key.destroy();
      }
    }
  },
  destroy: function () {
    if (hotkey.textbox) {
      hotkey.textbox.removeEventListener("keydown", hotkey.listen);
    }
    try {
      Services.obs.removeObserver(hotkey.observer, "addon-options-displayed");
    }
    catch (e) {}
  } 
}

/** HTTP Observer **/
var http = (function () {
  var cache = [];
  return {
    initialize: function () {
      Services.obs.addObserver(http.observer, "http-on-examine-response", false);
      Services.obs.addObserver(http.observer, "http-on-examine-cached-response", false);
    },
    destroy: function () {
      try {
        Services.obs.removeObserver(http.observer, "http-on-examine-response");
      }
      catch (e) {}
      try {
        Services.obs.removeObserver(http.observer, "http-on-examine-cached-response");
      }
      catch (e) {}
    },
    observer: {
      observe: function(doc, aTopic, aData) {
        var channel = doc.QueryInterface(Ci.nsIHttpChannel);
        if(channel.requestMethod != "GET") {
          return;
        }
        channel.visitResponseHeaders({
          visitHeader: function ( aHeader, aValue ) {
            if ( aHeader.indexOf( "Content-Type" ) != -1 ) {
              if ( aValue.indexOf("audio") != -1 || aValue.indexOf("video") != -1 ) {
                var request = doc.QueryInterface(Ci.nsIRequest);
                var url = request.name
                  .replace(/signature\=[^\&]*\&/, "")
                  .replace(/range\=[^\&]*\&/, "")
                  .replace(/expire\=[^\&]*\&/, "");
                if (cache.indexOf(url) == -1) {
                  cache.push(url);
                  var notificationCallbacks =
                    channel.notificationCallbacks ? 
                      channel.notificationCallbacks : channel.loadGroup.notificationCallbacks;
               
                  if (notificationCallbacks) {
                    var domWin = notificationCallbacks.getInterface(Ci.nsIDOMWindow);
                    IDExtractor({
                      origin: domWin.top.document.URL,
                      title: aValue.split("/")[0] + "_" + domWin.top.document.title,
                      vInfo: {
                        url: request.name,
                        container: aValue.split("/")[1],
                        audioBitrate: "",
                        audioEncoding: "",
                        resolution: "",
                        quality: ""
                      }
                    });
                    monitor(tabs.activeTab);
                  }
                }
              }
            }
          }
        });
      }
    }
  }
})();
//http.initialize ();

/** Pref listener **/
sp.on("dFolder", function () {
  if (prefs.dFolder == "5" && !prefs.userFolder) {
    rPanel.hide();
    var nsIFilePicker = Ci.nsIFilePicker;
    var fp = Cc["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);
    fp.init(windows.active, _("msg13"), nsIFilePicker.modeGetFolder);
    var res = fp.show();
    if (res != nsIFilePicker.returnCancel) {
      _prefs.setComplexValue("userFolder", fp.file.path);
    }
    else {
      prefs.dFolder = 2;
    }
  }
});
  
/** Detect a YouTube download link, download it and extract the audio**/
var listener = (function () {
  var objs = [];
  function remove (dl) {
    objs.forEach(function (obj, index) {
      if (obj.id == dl.id) {
        objs[index] = null;
      }
    });
    objs = objs.filter(function (a){return a});
    
    if (!objs.length) {
      yButton.tooltiptext = config.tooltip;
      yButton.progress = 0;
    }
  }
  
  return {
    onDetectStart: function () {
      rPanel.port.emit('detect', _("msg7"));
    },
    onDetectDone: function () {},
    onDownloadStart: function (dl) {
      rPanel.port.emit(
        'download-start', 
        dl.id, 
        dl.displayName ? dl.displayName : (new FileUtils.File(dl.target.path)).leafName, 
        _("msg6")
      );
    },
    onDownloadPaused: function (dl) {
      rPanel.port.emit('download-paused', dl.id, _("msg12"));
    },
    onDownloadDone: function (dl, error) {
      rPanel.port.emit('download-done', dl.id, _("msg8"), !prefs.doExtract || error);
      remove(dl);
    },
    onExtractStart: function (id) {
      rPanel.port.emit('extract', id, _("msg9"));
    },
    onExtractDone: function (id) {
      rPanel.port.emit('extract', id, _("msg10"), true);
    },
    onProgress: function (dl) {
      rPanel.port.emit('download-update', 
        dl.id, 
        dl.amountTransferred / dl.size * 100, 
        _("msg11"), 
        format(dl.amountTransferred), 
        format(dl.size), 
        format(dl.speed)
      );
      //
      var exist = false;
      objs.forEach(function (obj) {if (dl.id == obj.id) exist = true;});
      if (!exist) objs.push(dl);
      
      var ttSize = 0, tSize = 0;
      objs.forEach(function (obj) {
        tSize += obj.size;
        ttSize += obj.amountTransferred;
      });
      yButton.progress = ttSize / tSize;
      yButton.tooltiptext = 
        _("tooltip4").replace("%1", (tSize/1024/1024).toFixed(1)) +
        "\n" +
        _("tooltip5").replace("%1", (ttSize/tSize*100).toFixed(1));
    },
    onError: remove,
    cancel: function (id) {
      download.cancel(id);
    }
  }
})();

var batch = (function () {
  var cache = {};
  var files = {};
  return {
    add: function (id) {
      cache[id] = 2;
    },
    execute: function (id, file, type, callback, pointer) {
      cache[id] -= 1;
      if (cache[id] == 1) {
        files[id] = file;
        if (callback) callback.apply(pointer);
      }
      else {
        var f1 = files[id], f2 = file;
        if (type == "audio") {
          [f1, f2] = [f2, f1];
        }
        
        ffmpeg.ffmpeg (function () {
          if (callback) callback.apply(pointer);
        }, null, prefs.deleteInputs, f1, f2);
      }
    }
  }
})();

/** **/
var isDASH = function (vInfo) {
  var v = [160, 133, 134, 135, 136, 137, 138, 264, 242, 243, 244, 245, 246, 247, 248],
      a = [139, 140, 141, 171, 172];
  if (v.indexOf(vInfo.itag) != -1) {
    return "v";
  }
  else if (a.indexOf(vInfo.itag) != -1) {
    return "a"
  }
  else {
    return false;
  }
}

/** Call this with new **/
var getVideo = (function () {
  return function (videoID, listener, fIndex, noAudio, callback, pointer) {
    var doExtract = noAudio ? false : prefs.doExtract;
    var batchID;  // For batch job
  
    function onDetect () {
      listener.onDetectStart();
      youtube.getLink(videoID, fIndex, function (e, vInfo, gInfo) {
        listener.onDetectDone();
        //Remux audio-only streams even if doExtract is not active
        if (!noAudio && isDASH(vInfo) == "a" && prefs.doRemux) {
          doExtract = true;
        }
        if (e) {
          notify(_('name'), e);
        }
        else {
          onFile (vInfo, gInfo);
        }
      });
    }
    function onFile (vInfo, gInfo) {
      // Do not generate audio file if video has no sound track
      if (isDASH(vInfo) == "v") {
        doExtract = false;
      }
      // Do not generate audio file if video format is not FLV
      else if (doExtract && !(vInfo.container.toLowerCase() == "flv" || prefs.ffmpegPath)) {
        //Prevent conflict with video info notification
        timer.setTimeout(function () {
          notify(_('name'), _('msg5'))
        }, config.noAudioExtraction * 1000);
        doExtract = false;
      }
      // Download proper audio file if video-only format is selected
      if (isDASH(vInfo) == "v") {
        if (!prefs.showAudioDownloadInstruction) {
          var tmp = prompts2(_("msg22"), _("msg23"), "", "", _("msg21"), true);
          prefs.showAudioDownloadInstruction = tmp.check.value;
          prefs.doBatchMode = tmp.button == 0;
        }
        if (prefs.doBatchMode) {
          // Selecting the audio file
          var tmp = vInfo.parent.formats.filter(function (a) {
            return [140, 141, 139, 171, 172].indexOf(a.itag) != -1;
          });
          if (tmp && tmp.length) {
            var afIndex;
            if ([133, 160, 242].indexOf(vInfo.itag) != -1) {  // Low quality
              tmp.sort(function (a, b) {
                var i = [140, 171, 139, 172, 141].indexOf(a.itag),
                    j = [140, 171, 139, 172, 141].indexOf(b.itag);
                return i > j;
              });
            }
            else if ([134, 135, 243, 244, 245, 246].indexOf(vInfo.itag) != -1) { // Medium quality
              tmp.sort(function (a, b) {
                var i = [140, 171, 172, 141, 139].indexOf(a.itag),
                    j = [140, 171, 172, 141, 139].indexOf(b.itag);
                return i > j;
              });
            }
            else {  //High quality
              tmp.sort(function (a, b) {
                var i = [141, 172, 140, 171, 139].indexOf(a.itag),
                    j = [141, 172, 140, 171, 139].indexOf(b.itag);
                return i > j;
              });
            }
            afIndex = tmp[0].itag;
            batchID = Math.floor((Math.random()*10000)+1);
            batch.add(batchID);
            vInfo.parent.formats.forEach (function (a, index) {
              if (a.itag == afIndex) {
                new getVideo(videoID, listener, index, true, function (f) {
                  batch.execute(batchID, f, "audio");
                });
              }
            });
          }
        }
      }
      var vFile;
      //Select folder by nsIFilePicker
      if (prefs.dFolder == 4) {
        let nsIFilePicker = Ci.nsIFilePicker;
        let fp = Cc["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);
        fp.init(windows.active, _("prompt3"), nsIFilePicker.modeSave);
        fp.appendFilter(_("msg14"), "*." + vInfo.container);
        fp.defaultString = fileName(videoID, vInfo, gInfo);
        let res = fp.show();
        if (res == nsIFilePicker.returnCancel) {
          // Still no id. Generating a random one
          var id = Math.floor(Math.random()*101) + 10000;
          listener.onDownloadStart({
            id: id,
            displayName: "-"
          });
          listener.onDownloadDone({id: id}, true);
          return;
        }
        vFile = fp.file;
      }
      //Select folder by userFolder
      else if (prefs.dFolder == 5) {
        try {
          //Simple-prefs doesnt support complex type
          vFile = _prefs.getComplexValue("userFolder", Ci.nsIFile);
          vFile.append(fileName(videoID, vInfo, gInfo));
        }
        catch (e) {
          notify(_("name"), _("err7") + "\n\n" + _("err") + ": " + e.message);
          return;
        }
      }
      else {
        var videoPath = [];
        switch(prefs.dFolder) {
          case 2:
            root = "TmpD";
            let folder = Math.random().toString(36).substr(2,16);
            videoPath.push("iaextractor");
            videoPath.push(folder);
            break;
          case 0:
            root = "DfltDwnld"
            break;
          case 1:
            root = "Home";
            break;
          case 3:
            root = "Desk";
            break;
        }
        videoPath.push(fileName(videoID, vInfo, gInfo));
        vFile = FileUtils.getFile(root, videoPath);
      }
      var aFile, sFile;
      var vFile_first = true, aFile_first = true, sFile_first = true;
      onDownload(vInfo, {
        get vFile () {
          if (vFile_first) {
            vFile.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, FileUtils.PERMS_FILE);
            vFile_first = false;
          }
          return vFile;
        },
        get aFile () {
          if (aFile_first) {
            //To mach audio name with video name in case of duplication
            let name = vFile.leafName.replace(/\.+[^\.]*$/, "");
            aFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
            aFile.initWithPath(vFile.parent.path);
            aFile.append(name + ".aac");
            aFile_first = false;
          }
          return aFile;
        },
        get sFile () {
          if (aFile_first) {
            let name = vFile.leafName.replace(/\.+[^\.]*$/, "");
            sFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
            sFile.initWithPath(vFile.parent.path);
            sFile.append(name + ".srt");
            sFile_first = false;
          }
          return sFile;
        }
      });
    }
    function onDownload (vInfo, obj) {
      var dr = new download.get({
        progress: listener.onProgress,
        paused: listener.onDownloadPaused,
        done: function (dl) {
          listener.onDownloadDone(dl, !doExtract);
          onExtract (vInfo, dl, obj);
        },
        error: function (dl) {
          listener.onError(dl);
          listener.onDownloadDone(dl, true);
        }
      });
      dr(vInfo.url, obj.vFile, null, false, function (dl) {
        listener.onDownloadStart(dl);
      });
      notify(
        _('name'), 
        _('msg3').replace("%1", vInfo.quality)
          .replace("%2", vInfo.container)
          .replace("%3", vInfo.resolution)
          .replace("%6", vInfo.audioEncoding || "")
          .replace("%7", vInfo.audioBitrate || "")
      );
      onSubtitle(obj);
    }
    function onExtract (vInfo, dl, obj) {
      var id = dl.id;

      function afterExtract (e) {
        if (e) notify(_('name'), e);
        if (prefs.open) {
          try {
            obj.vFile.reveal();
          }
          catch(_e) {
            tabs.open(obj.vFile.parent.path);
          }
        }
        if (callback) callback.apply(pointer, [obj.vFile]);
        if (batchID) batch.execute(batchID, obj.vFile, "video");
      }
      if (!doExtract) {
        return afterExtract();
      }
      listener.onExtractStart(id);
      if (vInfo.container == "flv") {
        extract.perform(id, obj.vFile, obj.aFile, function (id, e) {
          if (e && prefs.ffmpegPath) {
            ffmpeg.ffmpeg (function () {
              listener.onExtractDone(id);
              afterExtract();
            }, null, false, obj.vFile);
          }
          else {
            listener.onExtractDone(id);
            afterExtract(prefs.extension == "0" ? e : null);
          }
        });
      }
      else {
        ffmpeg.ffmpeg (function () {
          listener.onExtractDone(id);
          afterExtract();
        }, null, (isDASH(vInfo) && prefs.deleteInputs), obj.vFile);
      }
    }
    function onSubtitle (obj) {
      if (!prefs.doSubtitle) return;

      subtitle.get(videoID, prefs.subtitleLang, obj.sFile, function (e) {
        if (e) notify(_('name'), e);
      });
    }
    //
    if (typeof(videoID) == "object") {
      var obj = videoID[0];
      onFile (obj.vInfo, obj);
    }
    else {
      onDetect();
    }
  }
})();

/** File naming **/
var fileName = function (videoID, vInfo, gInfo) {
  // Add " - DASH" to DASH only files
  return pattern = prefs.namePattern
    .replace ("[file_name]", gInfo.title + (isDASH(vInfo) ? " - DASH" : ""))
    .replace ("[extension]", vInfo.container)
    .replace ("[author]", gInfo.author)
    .replace ("[video_id]", videoID)
    .replace ("[video_resolution]", vInfo.resolution)
    .replace ("[audio_bitrate]", vInfo.audioBitrate + "K")
    //
    .replace(/\+/g, " ")
    .replace(/[:\?\¿]/g, "")
    .replace(/[\\\/]/g, "-")
    .replace(/[\*]/g, "^")
    .replace(/[\"]/g, "'")
    .replace(/[\<]/g, "[")
    .replace(/[\>]/g, "]")
    .replace(/[|]/g, "-");
}

/** Flashgot **/
var flashgot = (function () {
  var flashgot;
  try {
    flashgot = Cc["@maone.net/flashgot-service;1"]
      .getService(Ci.nsISupports).wrappedJSObject;
  }
  catch (e) {}
  return function (vInfo, gInfo) {
    if (flashgot) {
      var links = [{
        href: vInfo.url,
        fname : fileName(gInfo.video_id, vInfo, gInfo),
        description: _("msg15")
      }];
      links.document = windows.active.document;
      flashgot.download(links, flashgot.OP_ALL, flashgot.defaultDM);
    }
    else {
      notify(_("name"), _("err14"));
      timer.setTimeout(function (){
        tabs.open(config.urls.flashgot);
      }, 2000);
    }
  }
})();

/** DownThemAll **/
var downThemAll = (function () {
  var DTA = {};
  try {
    Cu.import("resource://dta/api.jsm", DTA);
  } 
  catch (e) {
    try {
      var glue = {}
      Cu.import("chrome://dta-modules/content/glue.jsm", glue);
      DTA = glue["require"]("api");
    }
    catch (e) {}
  }
  return function (vInfo, gInfo, turbo) {
    var fname = fileName(gInfo.video_id, vInfo, gInfo);
    if (DTA.saveSingleItem) {
      var iOService = Cc["@mozilla.org/network/io-service;1"]
        .getService(Ci.nsIIOService)
      try {
        DTA.saveSingleItem(windows.active, turbo, {
          url: new DTA.URL(iOService.newURI(vInfo.url, "UTF-8", null)),
          referrer: "",
          description: _("msg15"),
          fileName: fname,
          destinationName: fname,
          isPrivate: false,
          ultDescription: ""
        });
      }
      catch (e) {
        if (turbo) {
          downThemAll(vInfo, gInfo, false);
        }
      }
    }
    else {
      notify(_("name"), _("err15"));
      timer.setTimeout(function (){
        tabs.open(config.urls.downthemall);
      }, 2000);
    }
  }
})();

/** Reset all settings **/
sp.on("reset", function() {
  if (!windows.active.confirm(_("msg25"))) return
  
  prefs.extension = 0;
  prefs.quality = 2
  prefs.doExtract = true;
  prefs.doSubtitle = false;
  prefs.subtitleLang = 0;
  prefs.namePattern = "[file_name].[extension]";
  prefs.dFolder = 3;
  prefs.getFileSize = true;
  prefs.open = false;
  prefs.downloadHKey = "Accel + Shift + Q";
  prefs.oneClickDownload = false;
  prefs.silentOneClickDownload = true;
  prefs.ffmpegInputs = "-i %input -q:a 0 %output.mp3";
  prefs.ffmpegInputs4 = "-i %audio -i %video -acodec copy -vcodec copy %output";
  prefs.ffmpegInputs3 = "-i %input -acodec copy -vn %output";
  prefs.doBatchMode = true;
  prefs.doRemux = true;
  prefs.deleteInputs = true;
  prefs.welcome = true;
  prefs.forceVisible = true
});

/** Notifier **/
// https://github.com/fwenzel/copy-shorturl/blob/master/lib/simple-notify.js
var notify = (function () {
  return function (title, text) {
    try {
      let alertServ = Cc["@mozilla.org/alerts-service;1"].
                      getService(Ci.nsIAlertsService);
      alertServ.showAlertNotification(data.url("report/open.png"), title, text);
    }
    catch (e) {
      let browser = windows.active.gBrowser,
          notificationBox = browser.getNotificationBox();

      notification = notificationBox.appendNotification(
        text, 
        'jetpack-notification-box',
        data.url("report/open.png"), 
        notificationBox.PRIORITY_INFO_MEDIUM, 
        []
      );
      timer.setTimeout(function() {
        notification.close();
      }, config.desktopNotification * 1000);
    }
  }
})();