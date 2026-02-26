import type { PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ locals: { supabase } }) => {
	const { data: count } = await supabase.rpc('get_source_count')
	return {
		sourceCount: count as number | null,
	}
}
