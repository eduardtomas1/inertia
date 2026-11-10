"""Assemble the six actual Blender renders and check the review artifact set."""
import argparse
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROLES=[('investigator','Investigator'),('builder','Builder / Fixer'),
       ('marketer','Marketing'),('workflow-planner','Workflow planner'),
       ('writer','Writer'),('creative','Creative')]
p=argparse.ArgumentParser()
p.add_argument('--root',type=Path,default=Path('source-assets/custom-agent-marks'))
args=p.parse_args()
font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',22)
smallfont=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',16)
w,h=480,524
sheet=Image.new('RGB',(w*3,h*2),(222,221,217))
details=Image.new('RGB',(w*3,400*2),(222,221,217))
small=Image.new('RGB',(6*220,2*244),(238,237,233))
report=[]
for i,(role,label) in enumerate(ROLES):
    folder=args.root/role
    assert (folder/(role+'.blend')).stat().st_size>1000
    with Image.open(folder/(role+'-preview.png')) as source:
        preview=source.convert('RGB')
        assert preview.size==(900,900),(role,preview.size)
        detail=preview.crop((190,420,710,840)).resize((480,368),Image.Resampling.LANCZOS)
        preview=preview.resize((w,w),Image.Resampling.LANCZOS)
    x,y=(i%3)*w,(i//3)*h
    sheet.paste(preview,(x,y))
    draw=ImageDraw.Draw(sheet)
    footer=preview.getpixel((w//2,w-1))
    draw.rectangle((x,y+w,x+w,y+h),fill=footer)
    draw.text((x+w//2,y+w+18),label,fill=(47,49,50),font=font,anchor='mm')
    dx,dy=(i%3)*w,(i//3)*400
    details.paste(detail,(dx,dy))
    dd=ImageDraw.Draw(details)
    dd.rectangle((dx,dy+368,dx+w,dy+400),fill=detail.getpixel((w//2,367)))
    dd.text((dx+w//2,dy+383),label,fill=(47,49,50),font=smallfont,anchor='mm')
    with Image.open(folder/(role+'-transparent.png')) as source:
        im=source.convert('RGBA')
        assert im.size==(900,900),(role,im.size)
        alpha=im.getchannel('A')
        bounds=alpha.getbbox()
        assert alpha.getextrema()==(0,255),(role,alpha.getextrema())
        assert bounds and min(bounds[:2])>0 and max(bounds[2:])<900,(role,bounds)
        report.append({'role':role,'size':list(im.size),'alpha_bounds':list(bounds),
            'blend_bytes':(folder/(role+'.blend')).stat().st_size})
        for row,bg in enumerate([(30,34,41),(244,243,239)]):
            tile=Image.new('RGBA',(220,244),bg+(255,))
            for size,dx,dy in [(128,46,8),(64,78,141)]:
                tile.alpha_composite(im.resize((size,size),Image.Resampling.LANCZOS),(dx,dy))
            d=ImageDraw.Draw(tile)
            d.text((110,226),label,fill=(235,235,232) if row==0 else (47,49,50),font=smallfont,anchor='mm')
            small.paste(tile.convert('RGB'),(i*220,row*244))
sheet.save(args.root/'family-preview.png')
details.save(args.root/'family-details.png')
small.save(args.root/'family-readability.png')
(args.root/'review-manifest.json').write_text(json.dumps(report,indent=2)+'\n')
print('Verified six .blend files, six studio PNGs and six RGBA PNGs; wrote family review sheets.')
