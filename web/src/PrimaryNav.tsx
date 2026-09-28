export type ContentSection = 'character' | 'cg' | 'picture' | 'asmr'

const sections: { id: ContentSection; label: string }[] = [
  { id: 'character', label: '角色立绘' },
  { id: 'cg', label: 'CG 资源' },
  { id: 'picture', label: '插画档案' },
  { id: 'asmr', label: 'ASMR 台本' },
]

/** Keep all four destinations in the same position on every content page. */
export default function PrimaryNav({ active, onSelect }: {
  active: ContentSection
  onSelect: (section: ContentSection) => void
}) {
  return <nav className="primary-nav" aria-label="内容导航">
    {sections.map(({ id, label }) => <button key={id}
      type="button" className={active === id ? 'active' : ''}
      aria-current={active === id ? 'page' : undefined}
      onClick={() => onSelect(id)}>{label}</button>)}
  </nav>
}
