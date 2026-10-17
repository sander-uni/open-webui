// Fork addition: keep Open WebUI from pausing other apps' audio on iOS.
//
// On iOS, any sound a page plays (the silent clip the text-to-speech player plays on the first
// tap to unlock audio, notification sounds) takes the audio session and pauses Music/Spotify.
// While idle the page uses the "ambient" session, which mixes with other audio. Real playback
// (text-to-speech, voice calls, recording) switches to "auto" (WebKit's normal behaviour) and
// back afterwards. navigator.audioSession exists in Safari 16.4+ / iOS 17+; elsewhere this
// does nothing.
type SessionType = 'auto' | 'ambient' | 'playback' | 'play-and-record' | 'transient';

export const setAudioSession = (type: SessionType) => {
	try {
		const session = (navigator as any)?.audioSession;
		if (session && session.type !== type) {
			session.type = type;
		}
	} catch {
		// unsupported browser: nothing to do
	}
};
