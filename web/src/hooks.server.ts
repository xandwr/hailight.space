import { PUBLIC_SUPABASE_PROJECT_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY } from '$env/static/public'
import { createServerClient } from '@supabase/ssr'
import { redirect, type Handle } from '@sveltejs/kit'

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.supabase = createServerClient(PUBLIC_SUPABASE_PROJECT_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
		cookies: {
			getAll: () => event.cookies.getAll(),
			setAll: (cookiesToSet) => {
				cookiesToSet.forEach(({ name, value, options }) => {
					event.cookies.set(name, value, { ...options, path: '/' })
				})
			},
		},
	})

	event.locals.safeGetSession = async () => {
		const { data: { session } } = await event.locals.supabase.auth.getSession()
		if (!session) {
			return { session: null, user: null }
		}

		const { data: { user }, error } = await event.locals.supabase.auth.getUser()
		if (error) {
			return { session: null, user: null }
		}

		return { session, user }
	}

	// Protect all routes except public pages
	const publicPaths = ['/', '/about', '/sitemap.xml']
	const isPublic = publicPaths.includes(event.url.pathname) || event.url.pathname.startsWith('/auth')
	if (!isPublic) {
		const { session } = await event.locals.safeGetSession()
		if (!session) {
			redirect(303, '/auth')
		}
	}

	return resolve(event, {
		filterSerializedResponseHeaders(name) {
			return name === 'content-range' || name === 'x-supabase-api-version'
		},
	})
}
