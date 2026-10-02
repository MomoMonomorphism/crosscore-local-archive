import PrimaryNav, { type ContentSection } from './PrimaryNav'

const isPublicPreview = import.meta.env.VITE_STATIC_DEMO === '1'
const repositoryUrl = 'https://github.com/MomoMonomorphism/crosscore-local-archive'

export default function GalleryTopbar({ active, onSelect }: {
  active: ContentSection
  onSelect: (section: ContentSection) => void
}) {
  return <header className="gallery-topbar">
    <button type="button" className="gallery-brand" onClick={() => onSelect('character')}
      title="返回角色立绘" aria-label="CC · 返回角色立绘">
      <b><span>CC</span></b><span>CROSSCORE<small>{isPublicPreview ? '非官方演示' : 'LOCAL ARCHIVE'}</small></span>
    </button>
    <PrimaryNav active={active} onSelect={onSelect}/>
    <div className="gallery-topbar-actions">
      <span className="gallery-edition" aria-label={isPublicPreview ? '在线演示版' : '本地版'}>
        <span className="gallery-edition-dot" aria-hidden="true"/>{isPublicPreview ? '在线演示' : '本地版'}
      </span>
      <a className="gallery-repository-link" href={repositoryUrl} target="_blank" rel="noopener noreferrer"
        aria-label="在 GitHub 查看项目（新标签页）" title="在 GitHub 查看项目">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
          <path d="M12 .75a11.25 11.25 0 0 0-3.56 21.92c.56.1.77-.24.77-.54v-2.02c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.68.08-.68 1.13.08 1.73 1.16 1.73 1.16 1 .1.71 2.65 3.29 1.88.1-.72.4-1.21.72-1.49-2.5-.28-5.13-1.25-5.13-5.56 0-1.23.44-2.23 1.16-3.02-.12-.29-.5-1.43.11-2.98 0 0 .95-.3 3.1 1.15A10.8 10.8 0 0 1 12 6.36c.96 0 1.93.13 2.83.38 2.15-1.45 3.09-1.15 3.09-1.15.61 1.55.23 2.69.12 2.98.72.79 1.15 1.79 1.15 3.02 0 4.32-2.63 5.27-5.14 5.55.41.36.77 1.05.77 2.12v2.87c0 .3.2.65.78.54A11.25 11.25 0 0 0 12 .75Z"/>
        </svg>
      </a>
    </div>
  </header>
}
