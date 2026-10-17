// Fork addition: keep Open WebUI from pausing other apps' audio on iOS.
//
// On iOS, any sound a page plays (the silent clip the text-to-speech player plays on the first
// tap to unlock audio, notification sounds) takes the audio session and pauses Music/Spotify.
// While idle the page uses the "ambient" session, which mixes with other audio. Everything that
// really plays or records (text-to-speech, browser speech, voice calls, recording) holds a claim
// while it runs; the session is "auto" (WebKit's normal behaviour) while any claim is held and
// goes back to "ambient" when the last one is released. navigator.audioSession exists in
// Safari 16.4+ / iOS 17+; elsewhere this does nothing.
type SessionType = 'auto' | 'ambient' | 'playback' | 'play-and-record' | 'transient';

const claims = new Set<symbol>();

const apply = (type: SessionType) => {
	try {
		const session = (navigator as any)?.audioSession;
		if (session && session.type !== type) {
			session.type = type;
		}
	} catch {
		// unsupported browser: nothing to do
	}
};

/** Idle setting; does nothing while something holds a claim. */
export const setAudioSession = (type: SessionType) => {
	if (type === 'ambient' && claims.size) return;
	apply(type);
};

/** Take the audio session for playback or recording. Call the returned function when done
 * (calling it more than once is harmless). */
export const claimAudioSession = (): (() => void) => {
	const token = Symbol('audio-claim');
	claims.add(token);
	apply('auto');
	return () => {
		if (!claims.delete(token)) return;
		if (!claims.size) apply('ambient');
	};
};
