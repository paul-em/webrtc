const URL = window.URL || window.webkitURL || window.mozURL || window.msURL;
const RTCPeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
const RTCSessionDescription = window.RTCSessionDescription || window.mozRTCSessionDescription;
const RTCIceCandidate = window.RTCIceCandidate || window.mozRTCIceCandidate;

const availableDevices = {
  cam: null,
  mic: null,
};
if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
  navigator.mediaDevices.enumerateDevices().then((devices) => {
    devices.forEach((device) => {
      if (device.kind === 'videoinput' || device.kind === 'video') {
        availableDevices.cam = true;
      }
      if (device.kind === 'audioinput' || device.kind === 'audio') {
        availableDevices.mic = true;
      }
    });
  });
  if (availableDevices.cam === null) {
    availableDevices.cam = false;
  }
  if (availableDevices.mic === null) {
    availableDevices.mic = false;
  }
} else {
  availableDevices.cam = true;
  availableDevices.mic = true;
}
const supported = !!(URL && URL.createObjectURL && RTCPeerConnection && document.location.protocol === 'https:');

class WebRTC {
  static getStreamUrl(stream) {
    let url;
    try {
      url = URL.createObjectURL(stream) || stream;
    } catch (e) {
      url = stream;
    }
    return url;
  }

  constructor(endpoint, room, id, localStream) {
    this.endpoint = endpoint;
    this.room = room;
    this.id = id;
    this.members = [];
    this.listeners = {};
    this.localStream = localStream;
    this.destroyed = false;
    this.mediaConstraints = {
      mandatory: {
        OfferToReceiveAudio: true,
        OfferToReceiveVideo: true,
      },
    };
    this.socket = new WebSocket(this.endpoint);
    this.socket.onopen = () => {
      this.signal('join', {
        id: this.id,
        room: this.room,
      });
      this.trigger(WebRTC.EVENT_START);
    };
    this.socket.onclose = () => {
      this.trigger(WebRTC.EVENT_END);
    };
    this.socket.onerror = (err) => {
      this.trigger(WebRTC.EVENT_ERROR, err);
    };
    this.socket.onmessage = (message) => {
      let msg;
      try {
        msg = JSON.parse(message.data);
      } catch (e) {
        this.trigger(WebRTC.EVENT_ERROR, new Error(`Parsing signaling server message: ${message.data}`));
        return;
      }
      const localName = `signal${msg.fn.substr(0, 1).toUpperCase() + msg.fn.substr(1)}`;
      if (this[localName]) {
        this[localName](msg.id, msg.payload);
      }
      this.trigger(WebRTC.EVENT_SIGNAL_MESSAGE, msg);
    };
  }

  hangup() {
    if (this.destroyed) {
      return;
    }
    if (this.localStream) {
      if (this.localStream.stop) {
        this.localStream.stop();
      }
      if (this.localStream.getVideoTracks && this.localStream.getVideoTracks()[0]) {
        this.localStream.getVideoTracks()[0].enabled = false;
      }
      if (this.localStream.getAudioTracks && this.localStream.getAudioTracks()[0]) {
        this.localStream.getAudioTracks()[0].enabled = false;
      }
      if (this.localStream.getTracks) {
        const tracks = this.localStream.getTracks();
        tracks.forEach((track) => {
          if (track && track.stop) {
            track.stop();
          }
        });
      }
    }
    this.signal('leave');
    const socket = this.socket;
    this.destroyed = true;
    this.listeners = {};
    this.socket = null;
    setTimeout(() => {
      socket.close();
    }, 100);
  }

  signalJoin(senderId) {
    if (senderId === this.id) {
      return;
    }
    const existing = this.members.find(loopMember => loopMember.id === senderId);
    if (!existing) {
      const newMember = { id: senderId, connection: null };
      this.members.push(newMember);
      this.addPeerConnection(senderId);
      newMember.connection.createOffer((sessionDescription) => {
        this.signal('offer', {
          target: senderId,
          payload: sessionDescription,
        });
        newMember.connection.setLocalDescription(sessionDescription);
      }, (err) => {
        this.trigger(WebRTC.EVENT_ERROR, err);
      }, this.mediaConstraints);
    }
  }

  signalLeave(senderId) {
    const existing = this.members.find(loopMember => loopMember.id === senderId);
    if (existing) {
      this.members.splice(this.members.indexOf(existing), 1);
    }
  }

  signalIceCandidate(senderId, iceCandidate) {
    if (iceCandidate.candidate) {
      const member = this.members.find(loopMember => loopMember.id === senderId);
      if (member) {
        member.connection.addIceCandidate(new RTCIceCandidate({
          sdpMLineIndex: iceCandidate.label,
          candidate: iceCandidate.candidate,
        }));
      }
    }
  }

  signalOffer(senderId, offer) {
    const member = { id: senderId, connection: null };
    this.members.push(member);
    this.addPeerConnection(senderId);
    member.connection.setRemoteDescription(new RTCSessionDescription(offer));
    member.connection.createAnswer((sessionDescription) => {
      member.connection.setLocalDescription(sessionDescription);
      this.signal('answer', {
        target: senderId,
        payload: sessionDescription,
      });
    }, (err) => {
      this.trigger(WebRTC.EVENT_ERROR, err);
    }, this.mediaConstraints);
  }

  signalAnswer(senderId, answer) {
    const member = this.members.find(loopMember => loopMember.id === senderId);
    if (member) {
      member.connection.setRemoteDescription(new RTCSessionDescription(answer));
    }
  }

  addPeerConnection(id) {
    const member = this.members.find(loopMember => loopMember.id === id);
    if (member) {
      const pc = new RTCPeerConnection({ iceServers: WebRTC.iceServers }, this.mediaConstraints);
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          this.signal('iceCandidate',
            {
              payload: {
                type: 'candidate',
                label: event.candidate.sdpMLineIndex,
                id: event.candidate.sdpMid,
                candidate: event.candidate.candidate,
              },
              target: id,
            });
        }
      };
      pc.onaddstream = (event) => {
        pc.streamURL = WebRTC.getStreamUrl(event.stream);
        member.remoteStreamURL = pc.streamURL;
        pc.stream = event.stream;
        this.trigger(WebRTC.EVENT_CONNECTED);
      };
      pc.onremovestream = () => {
        member.connection = null;
        member.remoteStreamURL = null;
        this.trigger(WebRTC.EVENT_END, id);
      };
      if (this.localStream) {
        pc.addStream(this.localStream);
      }
      pc.streamURL = '';
      pc.stream = '';
      member.connection = pc;
      this.trigger(WebRTC.EVENT_FOUND_REMOTE);
    }
  }

  addListener(event, cb) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(cb);
  }

  trigger(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach((cb) => {
        cb(data);
      });
    }
  }

  signal(fn, data) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({
        fn,
        data,
      }));
    }
  }
}

WebRTC.EVENT_START = 'start';
WebRTC.EVENT_END = 'end';
WebRTC.EVENT_ERROR = 'error';
WebRTC.EVENT_SIGNAL_MESSAGE = 'signalMessage';
WebRTC.EVENT_CONNECTED = 'connected';
WebRTC.EVENT_FOUND_REMOTE = 'foundRemote';
WebRTC.availableDevices = availableDevices;
WebRTC.supported = supported;
WebRTC.iceServers = [
  {
    url: 'stun:148.251.126.74:5349',
  },
  {
    url: 'turn:148.251.126.74:5349',
    username: 'vl',
    credential: 'bfPB1VMy',
  },
  {
    url: 'stun:148.251.126.74:3478',
  },
  {
    url: 'turn:148.251.126.74:3478',
    username: 'vl',
    credential: 'bfPB1VMy',
  },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  { urls: 'stun:stun01.sipphone.com' },
  { urls: 'stun:stun.ekiga.net' },
  { urls: 'stun:stun.fwdnet.net' },
  { urls: 'stun:stun.ideasip.com' },
  { urls: 'stun:stun.iptel.org' },
  { urls: 'stun:stun.rixtelecom.se' },
  { urls: 'stun:stun.schlund.de' },
  { urls: 'stun:stunserver.org' },
  { urls: 'stun:stun.softjoys.com' },
  { urls: 'stun:stun.voiparound.com' },
  { urls: 'stun:stun.voipbuster.com' },
  { urls: 'stun:stun.voipstunt.com' },
  { urls: 'stun:stun.voxgratia.org' },
  { urls: 'stun:stun.xten.com' },
];

export default WebRTC;