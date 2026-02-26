import type { SupabaseClient } from '@supabase/supabase-js'

let sessionId: string | null = null

function getSessionId(): string {
	if (sessionId) return sessionId

	// Reuse session ID within a browser session (tab lifetime)
	const stored = typeof sessionStorage !== 'undefined' && sessionStorage.getItem('hailight_session_id')
	if (stored) {
		sessionId = stored
		return sessionId
	}

	sessionId = crypto.randomUUID()
	if (typeof sessionStorage !== 'undefined') {
		sessionStorage.setItem('hailight_session_id', sessionId)
	}
	return sessionId
}

// Buffer events and flush periodically to reduce DB round-trips
let buffer: EventPayload[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let supabaseRef: SupabaseClient | null = null
let userIdRef: string | null = null

const FLUSH_INTERVAL = 5_000 // 5 seconds
const FLUSH_SIZE = 10 // flush if buffer hits this size

interface EventPayload {
	user_id: string
	session_id: string
	event_type: string
	properties: Record<string, unknown>
	page: string | null
	referrer: string | null
	created_at: string
}

export function initAnalytics(supabase: SupabaseClient, userId: string) {
	supabaseRef = supabase
	userIdRef = userId

	// Flush on page unload
	if (typeof window !== 'undefined') {
		window.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'hidden') flush()
		})
		window.addEventListener('pagehide', flush)
	}
}

export function track(eventType: string, properties: Record<string, unknown> = {}) {
	if (!userIdRef || typeof window === 'undefined') return

	buffer.push({
		user_id: userIdRef,
		session_id: getSessionId(),
		event_type: eventType,
		properties,
		page: window.location.pathname,
		referrer: document.referrer || null,
		created_at: new Date().toISOString(),
	})

	if (buffer.length >= FLUSH_SIZE) {
		flush()
	} else if (!flushTimer) {
		flushTimer = setTimeout(flush, FLUSH_INTERVAL)
	}
}

async function flush() {
	if (flushTimer) {
		clearTimeout(flushTimer)
		flushTimer = null
	}

	if (!buffer.length || !supabaseRef) return

	const batch = buffer.splice(0)

	try {
		const { error } = await supabaseRef.from('events').insert(batch)
		if (error) {
			// Put events back if insert failed — don't lose data
			buffer.unshift(...batch)
			console.warn('[analytics] flush failed, will retry:', error.message)
		}
	} catch {
		buffer.unshift(...batch)
	}
}
