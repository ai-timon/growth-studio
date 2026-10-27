// Bouchons de @timon/ui pour le banc de rendu (approximation des composants shadcn du produit).
const React = window.React; const h = React.createElement
const base = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, height: 32, padding: '0 12px', borderRadius: 'var(--radius)', fontSize: 13, fontWeight: 500, cursor: 'pointer', border: '1px solid transparent', fontFamily: 'inherit', whiteSpace: 'nowrap' }
const variants = {
  default: { background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' },
  outline: { background: 'hsl(var(--background))', color: 'hsl(var(--foreground))', borderColor: 'hsl(var(--input))' },
  ghost: { background: 'transparent', color: 'hsl(var(--foreground))' },
  secondary: { background: 'hsl(var(--secondary))', color: 'hsl(var(--foreground))' },
  destructive: { background: 'hsl(var(--destructive))', color: 'hsl(var(--destructive-foreground))' },
  link: { background: 'transparent', color: 'hsl(var(--primary))', padding: 0, height: 'auto' },
}
export const Button = React.forwardRef(function Button({ variant = 'default', size, style, asChild, ...p }, ref) {
  return h('button', { ref, ...p, style: { ...base, ...(size === 'lg' ? { height: 40, padding: '0 20px' } : {}), ...variants[variant], ...(p.disabled ? { opacity: 0.5, cursor: 'default' } : {}), ...style } })
})
export const Switch = ({ checked, onCheckedChange, disabled, ...p }) => h('button', { role: 'switch', 'aria-checked': !!checked, disabled, onClick: () => onCheckedChange && onCheckedChange(!checked), ...p,
  style: { width: 36, height: 20, borderRadius: 999, border: 0, padding: 2, background: checked ? 'hsl(var(--primary))' : 'hsl(var(--input))', cursor: 'pointer', display: 'inline-flex', justifyContent: checked ? 'flex-end' : 'flex-start' } },
  h('span', { style: { width: 16, height: 16, borderRadius: 999, background: 'hsl(var(--background))', boxShadow: '0 1px 2px rgba(0,0,0,.2)' } }))
const MenuCtx = React.createContext(null)
export function DropdownMenu({ children, open: o, onOpenChange }) { const [open, setOpen] = React.useState(!!window.__menuOpen); return h(MenuCtx.Provider, { value: { open, setOpen } }, h('div', { style: { position: 'relative', display: 'inline-block' } }, children)) }
export function DropdownMenuTrigger({ children }) { const c = React.useContext(MenuCtx); return React.cloneElement(children, { onClick: () => c.setOpen(!c.open) }) }
export function DropdownMenuContent({ children, align }) { const c = React.useContext(MenuCtx); return c.open ? h('div', { role: 'menu', style: { position: 'absolute', top: '100%', [align === 'end' ? 'right' : 'left']: 0, marginTop: 4, minWidth: 220, padding: 4, background: 'hsl(var(--popover))', color: 'hsl(var(--popover-foreground))', border: '1px solid hsl(var(--border))', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-2)', zIndex: 50 } }, children) : null }
export function DropdownMenuItem({ children, onSelect, disabled, className, style }) { return h('div', { role: 'menuitem', onClick: () => !disabled && onSelect && onSelect(), style: { padding: '6px 8px', fontSize: 13, borderRadius: 4, cursor: 'default', opacity: disabled ? 0.5 : 1, ...style } }, children) }
export const DropdownMenuSeparator = () => h('div', { style: { height: 1, margin: '4px -4px', background: 'hsl(var(--border))' } })
export const DropdownMenuLabel = ({ children }) => h('div', { style: { padding: '6px 8px', fontSize: 12, fontWeight: 600 } }, children)
export const openInIsland = () => true
export const useIslandContent = () => ({ setTitle() {} })
export const getLocale = () => new URLSearchParams(location.search).get('lang') || 'en'
// same contract as the product: messages[locale][key], then English, then the key; {name} variables replaced
export function createTranslator(messages) {
  return (key, vars) => {
    const lang = getLocale()
    // `?lang=xx` without `page`: the messages index.html loaded (the studio is then rendered without its LocaleGate)
    let s = (messages[lang] && messages[lang][key]) ?? (lang !== 'en' && window.__i18n && window.__i18n[key]) ?? (messages.en && messages.en[key]) ?? key
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v))
    return s
  }
}
