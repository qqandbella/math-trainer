import { useCallback, useEffect, useState } from 'react'

export type RouteName =
  | 'home'
  | 'daily'
  | 'custom'
  | 'timed'
  | 'mental'
  | 'reports'
  | 'sync'
  | 'parent'

const ROUTES: RouteName[] = [
  'home',
  'daily',
  'custom',
  'timed',
  'mental',
  'reports',
  'sync',
  'parent',
]

function parse(hash: string): RouteName {
  const name = hash.replace(/^#\/?/, '').split('?')[0] ?? ''
  if (name === '') return 'home'
  return (ROUTES as string[]).includes(name) ? (name as RouteName) : 'home'
}

export function useRoute(): [RouteName, (next: RouteName) => void] {
  const [route, setRoute] = useState<RouteName>(() => parse(window.location.hash))

  useEffect(() => {
    const onChange = (): void => setRoute(parse(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  const navigate = useCallback((next: RouteName) => {
    window.location.hash = next === 'home' ? '/' : `/${next}`
    window.scrollTo(0, 0)
  }, [])

  return [route, navigate]
}
