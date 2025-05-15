import type { ComputedRef, MaybeRefOrGetter, Ref, ShallowRef } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import { defineBreadcrumb, useI18n, useSchemaOrg } from '#imports'
import { useSiteConfig } from '#site-config/app/composables/useSiteConfig'
import { createSitePathResolver } from '#site-config/app/composables/utils'
import { defu } from 'defu'
import { fixSlashes } from 'nuxt-site-config/urls'
import { useNuxtApp, useRoute, useRouter, useState } from 'nuxt/app'
import { withoutTrailingSlash } from 'ufo'
import { computed, inject, onScopeDispose, provide, ref, shallowRef, toValue, triggerRef, useId, watch } from 'vue'
import { pathBreadcrumbSegments } from '../../shared/breadcrumbs'

function withoutQuery(path: string) {
  return path.split('?')[0]
}

// todo: legacy, refactoring needed
function titleCase(s: string) {
  return s
    .replaceAll('-', ' ')
    .replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.substr(1).toLowerCase())
}

function pathToTitle(path: string = '') {
  return titleCase(path.split('/').pop()!)
}

type MaybeRefOrGetterArray<T> = MaybeRefOrGetter<MaybeRefOrGetter<T>[]>

type Resolved<T> = {
  [K in keyof T]: T[K] extends MaybeRefOrGetterArray<infer V> | undefined
    ? V[]
    : T[K] extends MaybeRefOrGetter<infer V>
      ? V
      : T[K]
}

function resolveReactivity<T extends object>(object: T): Readonly<Resolved<T>> {
  return Object.fromEntries(
    Object.entries(object).map(([key, value]) => {
      const resolvedValue = toValue(value)
      return [key, Array.isArray(resolvedValue) ? resolvedValue.map(toValue) : resolvedValue]
    }),
  ) as Resolved<T>
}

export interface BreadcrumbItemProps {
  to?: RouteLocationRaw
  current?: boolean
  label?: string
  ariaLabel?: string
}

export interface NormalizedBreadcrumbItemProps extends Omit<BreadcrumbItemProps, 'to'> {
  to?: string
}

export interface BreadcrumbProps {
  /**
   * The id of the breadcrumb list. You must provide a unique
   * id when adding multiple breadcrumb lists to the same page.
   *
   * @default 'breadcrumb'
   */
  id?: string
  /**
   * Generate the breadcrumbs based on a different path than the current route.
   */
  path?: MaybeRefOrGetter<string>
  /**
   * Append additional breadcrumb items to the end of the list. This is applied
   * after the `overrides` option.
   */
  append?: MaybeRefOrGetterArray<BreadcrumbItemProps>
  /**
   * Prepend additional breadcrumb items to the start of the list. This is applied
   * after the `overrides` option.
   */
  prepend?: MaybeRefOrGetterArray<BreadcrumbItemProps>
  /**
   * Override any of the breadcrumb items based on the index.
   */
  overrides?: MaybeRefOrGetterArray<BreadcrumbItemProps | false | undefined>
  /**
   * Should the schema.org breadcrumb be generated.
   *
   * @default true
   */
  schemaOrg?: boolean
  /**
   * The Aria Label for the breadcrumbs.
   * You shouldn't need to change this.
   *
   * @default 'Breadcrumbs'
   */
  ariaLabel?: string
  /**
   * Should the current breadcrumb item be shown.
   *
   * @default false
   */
  hideCurrent?: MaybeRefOrGetter<boolean>
  /**
   * Should the root breadcrumb be shown.
   *
   * @default false
   */
  hideRoot?: MaybeRefOrGetter<boolean>
  /**
   * Should breadcrumb items with non-existing path be shown.
   *
   * By default, every path segments will be present in breadcrumb list even if there is no corresponding page for such segment.
   *
   * @default false
   */
  hideNonExisting?: MaybeRefOrGetter<boolean>
  /**
   * The root segment of the breadcrumb list.
   *
   * By default, this will be `/`, unless you're using Nuxt I18n with a prefix strategy.
   */
  rootSegment?: string
}

export type ResolvedBreadcrumbProps = Resolved<BreadcrumbProps>

// exporting old names for backwards compatibility, but using new ones
type BreadcrumbOptions = BreadcrumbProps
type NormalizedBreadcrumbOptions = Required<Resolved<BreadcrumbOptions>>

interface BreadcrumbContext {
  optionStack: ShallowRef<Map<string, Readonly<BreadcrumbOptions>>>
  flatOptions: ComputedRef<NormalizedBreadcrumbOptions>
  isPaused: Ref<boolean>
  items: ComputedRef<NormalizedBreadcrumbItemProps[]>
  isSchemaOrgEnabled: boolean
}

function getBreadcrumbContextKey(id: string) {
  return `__NSU_BREADCRUMB_CONTEXT_${id}__`
}

function createBreadcrumbContext(id: string): BreadcrumbContext {
  const route = useRoute()

  const optionStack = shallowRef(new Map<string, BreadcrumbOptions>())
  const flatOptions = computed(() => {
    const result: NormalizedBreadcrumbOptions = {
      id: 'breadcrumb',
      path: route.path,
      append: [],
      prepend: [],
      overrides: [],
      schemaOrg: true,
      ariaLabel: 'Breadcrumbs',
      hideCurrent: false,
      hideRoot: false,
      hideNonExisting: false,
      rootSegment: '/',
    }

    for (const options of optionStack.value.values()) {
      const resolved = resolveReactivity(options)

      // we use keys of `result` instead of keys of `resolved` to prevent additional keys explosion
      // it also means that `result` must include all possible keys
      for (const key of Object.keys(result) as Array<keyof typeof result>) {
        const value = resolved[key]
        if (value !== undefined && !Array.isArray(value)) {
          (result[key] as unknown) = value
        }
      }

      if (resolved.overrides) {
        resolved.overrides.forEach((value, index) => {
          if (value !== undefined) {
            result.overrides[index] = value
          }
        })
      }

      // append/prepend items should be defined and there is no need for filtering
      // but it was implemented in old version, so it's needed for backward compatibility
      if (resolved.append) {
        result.append.push(...resolved.append.filter(Boolean))
      }

      if (resolved.prepend) {
        result.prepend.push(...resolved.prepend.filter(Boolean))
      }
    }

    return result
  })

  const nuxtApp = useNuxtApp()

  const cleanup: Array<() => void> = []
  onScopeDispose(() => {
    cleanup.forEach(stop => stop())
    cleanup.length = 0
  })

  // we need prevent breadcrumb items updates between page transitions
  // and during hydration since async data may be unavailable yet
  const isPaused = ref(import.meta.client && !!nuxtApp.isHydrating)

  if (import.meta.client) {
    const pause = () => {
      isPaused.value = true
    }

    const resume = () => {
      isPaused.value = false
    }

    cleanup.push(
      nuxtApp.hooks.hook('page:start', pause),
      nuxtApp.hooks.hook('page:finish', () => { !nuxtApp.isHydrating && resume() }),
      nuxtApp.hooks.hook('app:error', resume),
      nuxtApp.hooks.hook('app:suspense:resolve', resume),
    )
  }

  const router = useRouter()
  const i18n = useI18n()
  const siteConfig = useSiteConfig()

  // consider situation when breadcrumb component located in layout
  // and suspendable component located in page wants to override some crumbs
  // in theory there is potential hydration mismatch
  // because breadcrumb component may be rendered before the override occurs
  // so we need to sync breacrumbs from server to client for hydration
  // todo: check this theory and add test suite
  const lastItems = useState<NormalizedBreadcrumbItemProps[]>(`nuxt-seo:breadcrumb:${id}`, () => [])
  const items = computed(() => {
    if (import.meta.client && isPaused.value) {
      return lastItems.value
    }

    const options = flatOptions.value

    // despite type says, `toValue` for `defaultLocale` is needed since polyfill uses ref
    const rootNode = i18n.strategy === 'prefix' || (i18n.strategy !== 'no_prefix' && toValue(i18n.defaultLocale) !== toValue(i18n.locale))
      ? `${options.rootSegment}${toValue(i18n.locale)}`
      : options.rootSegment

    const current = withoutQuery(withoutTrailingSlash(options.path || rootNode))

    const segments = pathBreadcrumbSegments(current, rootNode)
      .map((path, index) => {
        const item: BreadcrumbItemProps = { to: path }
        const override = options.overrides[index]

        return override === false
          ? false
          : override === undefined
            ? item
            : defu(override, item)
      })
      .filter(segment => !!segment)

    // we gonna modify items so need to make a copy
    segments.unshift(...options.prepend.map(item => ({ ...item })))
    segments.push(...options.append.map(item => ({ ...item })))

    return segments
      .map((item) => {
        let fallbackLabel = ''
        let fallbackAriaLabel = ''

        const route = item.to ? router.resolve(item.to) : null
        if (route?.matched.length) {
          // todo: route meta should be augmented directly by extending `RouteMeta`
          const routeMeta = route.meta as typeof route.meta & { title?: string, breadcrumbLabel?: string, breadcrumbTitle?: string }
          if (routeMeta.breadcrumb) {
            Object.assign(item, routeMeta.breadcrumb)
          }

          const routeName = String(route.name).split('___')?.[0]
          if (routeName === 'index') {
            fallbackLabel = 'Home'
          }

          item.to = route.path

          fallbackLabel = routeMeta.breadcrumbLabel || routeMeta.breadcrumbTitle || routeMeta.title || fallbackLabel || pathToTitle(item.to)
          fallbackLabel = i18n.t(`breadcrumb.items.${routeName}.label`, fallbackLabel, { missingWarn: false })
          fallbackAriaLabel = i18n.t(`breadcrumb.items.${routeName}.ariaLabel`, fallbackAriaLabel, { missingWarn: false })
        }
        else if (options.hideNonExisting) {
          return false
        }
        else if (item.to && typeof item.to !== 'string') {
          if (import.meta.dev) {
            // todo: add warning
          }

          // or just set `to` to undefined?
          return false
        }

        item.current = item.current || item.to === current
        if (options.hideCurrent && item.current) {
          return false
        }

        if (item.to) {
          item.to = fixSlashes(siteConfig.trailingSlash, item.to)
          if (options.hideRoot && item.to === rootNode) {
            return false
          }

          fallbackLabel ||= pathToTitle(item.to)
        }

        item.label ||= fallbackLabel
        item.ariaLabel ||= fallbackAriaLabel || item.label

        return item as NormalizedBreadcrumbItemProps
      })
      .filter(item => !!item)
  })

  if (import.meta.client) {
    watch(items, (newItems) => {
      if (!isPaused.value) {
        lastItems.value = newItems
      }
    }, { immediate: true })
  }
  else {
    cleanup.push(nuxtApp.hooks.hook('app:rendered', () => {
      lastItems.value = items.value
    }))
  }

  return {
    optionStack,
    flatOptions,
    isPaused,
    items,
    isSchemaOrgEnabled: false,
  }
}

export function useBreadcrumbItems(options: BreadcrumbOptions = {}) {
  const breadcrumbId = options.id ?? 'breadcrumb'

  const contextKey = getBreadcrumbContextKey(breadcrumbId)
  let context = inject<BreadcrumbContext | null>(contextKey, null)
  if (!context) {
    context = createBreadcrumbContext(breadcrumbId)
    provide(contextKey, context)
  }

  const { optionStack, flatOptions, items } = context

  const optionsId = useId()
  optionStack.value.set(optionsId, options)
  triggerRef(optionStack)

  onScopeDispose(() => {
    optionStack.value.delete(optionsId)
    triggerRef(optionStack)
  })

  if (
    !context.isSchemaOrgEnabled
    // @ts-expect-error https://github.com/nuxt/nuxt/issues/23984
    && (import.meta.server || import.meta.dev || import.meta.env?.NODE_ENV === 'test')
    && flatOptions.value.schemaOrg
  ) {
    const siteResolver = createSitePathResolver({
      canonical: true,
      absolute: true,
    })

    useSchemaOrg([
      defineBreadcrumb({
        id: `#${breadcrumbId}`,
        itemListElement: computed(() => items.value.map(item => ({
          name: item.label || item.ariaLabel,
          item: item.to ? siteResolver(item.to) : undefined,
        }))),
      }),
    ])

    context.isSchemaOrgEnabled = true
  }
  else if (import.meta.dev && context.isSchemaOrgEnabled && !flatOptions.value.schemaOrg) {
    // todo: add warning
  }

  return items
}
