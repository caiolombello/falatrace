from pathlib import Path
import xml.etree.ElementTree as E, json,shutil
REPO=Path(__file__).resolve().parents[1]
out=REPO/'docs/assets';out.mkdir(parents=True,exist_ok=True)
kit=Path(__file__).resolve().parent/'source'
C={'ink':'#102B2A','paper':'#F4F1E9','mint':'#57D5B0','apricot':'#FFB377','muted':'#566B66','canvas':'#0B1716','deepMint':'#0F705A','rust':'#A34125','darkMuted':'#AAC0B8','recording':'#FF7373','error':'#FFB4AB'}
def mark(fg,dot,size=64):
 return f'<path d="M30 10H14V54H30" fill="none" stroke="{fg}" stroke-width="6" stroke-linecap="square" stroke-linejoin="miter"/><circle cx="44" cy="32" r="6" fill="{dot}"/>'
def svg(name,w,h,body,title,desc):
 p=out/name;p.write_text(f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" role="img" aria-labelledby="title desc"><title id="title">{title}</title><desc id="desc">{desc}</desc>{body}</svg>')
def txt(text,x,y,size=20,color=C['ink'],weight=400,mono=False):
 return f'<text x="{x}" y="{y}" fill="{color}" font-size="{size}" font-weight="{weight}" font-family="{("monospace" if mono else "system-ui, sans-serif")}">{text}</text>'
for mode,fg,dot in [('light',C['ink'],C['deepMint']),('dark',C['paper'],C['mint']),('mono','currentColor','currentColor')]:
 svg(f'falatrace-mark-{mode}.svg',64,64,mark(fg,dot),'FalaTrace source margin','An open citation bracket and a separate source anchor. This static mark does not indicate recording.')
for size in [16,24,32]:
 # Dedicated integer geometry, not merely a scaled 64px icon.
 unit=size//8; x=3 if size==16 else (5 if size==24 else 6); top=2 if size==16 else (3 if size==24 else 4); bottom=size-top
 mid=size/2; end=7 if size==16 else (11 if size==24 else 15); cx=12 if size==16 else (18 if size==24 else 24); rad=2 if size==16 else (3 if size==24 else 4)
 body=f'<path d="M{end} {top}H{x}V{bottom}H{end}" fill="none" stroke="currentColor" stroke-width="{unit}"/><circle cx="{cx}" cy="{mid}" r="{rad}" fill="currentColor"/>'
 svg(f'falatrace-symbolic-{size}.svg',size,size,body,'FalaTrace','Monochrome source bracket and separate anchor; static brand, not REC.')
svg('favicon.svg',64,64,f'<rect width="64" height="64" rx="12" fill="{C["ink"]}"/>'+mark(C['paper'],C['mint']),'FalaTrace favicon','Static source margin mark.')
svg('falatrace-avatar.svg',512,512,f'<rect width="512" height="512" rx="112" fill="{C["ink"]}"/><g transform="translate(32 32) scale(7)">'+mark(C['paper'],C['mint'])+'</g>','FalaTrace avatar','Optical coverage matches the favicon; central source anchor, not a recording indicator.')
for mode in ['light','dark']:
 tree=E.parse(kit/'assets'/f'falatrace-wordmark-{mode}.svg');root=tree.getroot();g=list(root)[-1];g.attrib['fill']=C['ink'] if mode=='light' else C['paper']
 for i,child in enumerate(g):
  transform=child.attrib.get('transform','')
  if transform.startswith('translate('):
   xy,rest=transform.split(')',1);x,y=xy[10:].split();child.attrib['transform']=f'translate({float(x)+i*0.45:.3f} {y})'+rest
 fg=C['ink'] if mode=='light' else C['paper'];dot=C['deepMint'] if mode=='light' else C['mint']
 svg(f'falatrace-wordmark-{mode}.svg',364,72,f'<g transform="translate(0 4)">'+mark(fg,dot)+'</g>'+E.tostring(g,encoding='unicode'),'FalaTrace','FalaTrace outlined wordmark, with an open citation bracket and source anchor.')
# One synthetic statement, citation and frame at exactly 02:08.
b=f'<rect width="1240" height="720" rx="18" fill="{C["paper"]}"/>'
b+=txt('Synthetic example · Interface concept',40,48,18,C['muted'])+txt('Notes linked to the moment.',40,115,42,weight=700)
b+=txt('sample-video.mp4 · no real people or recordings',40,153,17,C['muted'])
for x,title in [(40,'Transcript'),(450,'Note with source'),(860,'Frame on request')]:
 b+=f'<rect x="{x}" y="190" width="340" height="380" rx="12" fill="white" stroke="#D4DDD5"/>'+txt(title,x+24,230,22,weight=650)
 b+=txt('02:08',x+24,276,22,C['deepMint'],mono=True)
b+=txt('“The button is on the right.”',64,326,19)+txt('Scripted transcript',64,365,16,C['muted'])
b+=txt('Button position mentioned.',474,326,18)+txt('Back to the recording →',474,365,18,C['deepMint'])+txt('Scripted note · not an AI result',474,410,15,C['muted'])
b+='<rect x="884" y="310" width="290" height="150" rx="6" fill="#102B2A"/><rect x="1060" y="365" width="88" height="44" rx="5" fill="#57D5B0"/>'+txt('Frame illustration',898,344,16,C['paper'])+txt('2 / 8 frames · illustrative budget',884,492,15,C['rust'])+txt('Not a shipped Studio control',884,523,14,C['muted'])
b+='<path d="M60 624H1178" stroke="#D4DDD5" stroke-width="4"/><path d="M60 624H806" stroke="#0F705A" stroke-width="4"/><circle cx="806" cy="624" r="7" fill="#102B2A"/>'+txt('00:00',40,665,16,C['muted'],mono=True)+txt('02:08',775,665,16,C['deepMint'],mono=True)+txt('03:12',1130,665,16,C['muted'],mono=True)
svg('falatrace-workflow-concept.svg',1240,720,b,'Notes linked to the moment','Synthetic interface concept. Transcript, note and illustrative frame refer to 02:08 of sample-video.mp4; no model quality claim.')
b=f'<rect width="1200" height="630" fill="{C["paper"]}"/>'+f'<g transform="translate(54 52) scale(1.5)">'+mark(C['ink'],C['deepMint'])+'</g>'
b+=txt('FalaTrace',170,122,70,weight=700)+txt('Experimental alpha · Linux',60,216,40,C['rust'],weight=600)+txt('Your recordings.',60,318,64,weight=700)+txt('A trace you can follow.',60,398,64,weight=700)+txt('02:08  →  note  →  source',60,515,42,C['deepMint'],mono=True)+txt('Open source · AI integrations you choose',60,577,28,C['muted'])
svg('falatrace-social-card.svg',1200,630,b,'FalaTrace experimental alpha','Your recordings. A trace you can follow. An illustrative source reference, not a claim of verified AI accuracy.')
# Side-by-side exact-size, light/dark, avatar comparisons. All source is repo-native vector/code.
shutil.copyfile(kit/'assets/falatrace-mark-light.svg',out/'comparison-old-f.svg')
shutil.copyfile(kit/'THIRD-PARTY-NOTICES.txt',REPO/'branding/THIRD-PARTY-NOTICES.txt')
(REPO/'branding/tokens.json').write_text(json.dumps(C,indent=2)+'\n')
(out/'tokens.css').write_text(':root{'+''.join(f'--{k}:{v};' for k,v in C.items())+'font-family:system-ui,sans-serif;}')

print('Identity v2 SVGs generated; retained outlined font and notices.')
