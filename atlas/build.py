import markdown, re, html, sys
def build(src, out, title, kicker, disc):
    md=open(src).read()
    # pull mermaid blocks out before markdown
    blocks=[]
    def keep(m):
        blocks.append(m.group(1)); return f"\n\nMERMAIDBLOCK{len(blocks)-1}\n\n"
    md=re.sub(r"```mermaid\n(.*?)```", keep, md, flags=re.S)
    h=markdown.markdown(md, extensions=['tables','fenced_code','toc','sane_lists'], extension_configs={'toc':{'toc_depth':'2'}})
    for i,b in enumerate(blocks):
        h=h.replace(f"<p>MERMAIDBLOCK{i}</p>", f'<div class="diagram"><pre class="mermaid">{html.escape(b)}</pre></div>')
    h=re.sub(r"<p>::masthead::\s*(.*?)</p>", r'<div class="masthead"><span class="disc"></span><p>\1</p></div>', h, flags=re.S)
    h=re.sub(r"<p>::stamp::\s*(.*?)</p>", r'<p class="stamp">\1</p>', h, flags=re.S)
    h=h.replace("::red::",'<span class="pill red">').replace("::green::",'<span class="pill green">')
    h=re.sub(r'(<span class="pill (?:red|green)">)\s*([^<|]*?)(</td>)', r'\1\2</span>\3', h)
    h=re.sub(r"<table>", '<div class="tbl"><table>', h); h=h.replace("</table>","</table></div>")
    h=re.sub(r"<pre><code>", '<pre class="code"><code>', h)
    # first h1 -> header
    m=re.search(r"<h1[^>]*>(.*?)</h1>", h); h=h[:m.start()]+h[m.end():]
    toc=re.findall(r'<h2 id="([^"]+)">(.*?)</h2>', h)
    nav="".join(f'<a href="#{i}">{re.sub("<.*?>","",t)}</a>' for i,t in toc)
    page=TEMPLATE.replace("{{TITLE}}",title).replace("{{H1}}",m.group(1)).replace("{{KICKER}}",kicker).replace("{{NAV}}",nav).replace("{{BODY}}",h).replace("{{DISC}}",disc)
    open(out,'w').write(page)
TEMPLATE=open('template.html').read()
build('atlas.md','othello-atlas.html','Othello Atlas','System atlas · what exists and where it breaks','white')
build('blueprint.md','othello-blueprint.html','Othello Blueprint','Frozen design · what Othello is meant to be','black')
