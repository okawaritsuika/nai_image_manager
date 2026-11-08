"""Non-destructive, document-coordinate retouching. No external services.

Algorithms ported from the sibling dakiMaker/retouch/engine.py module.
"""
import math
import hashlib
import json
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps, ImageCms

KINDS = {'color','tone','paint','clone','blur','sharpen','line','texture','liquify'}
BLEND_MODES = {'normal', 'soft-light', 'color', 'multiply', 'screen'}
LIQUIFY_MODES = {'push', 'expand', 'shrink', 'clockwise', 'counterclockwise'}
try:
    SRGB = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
except ImportError:
    # The browser Pillow build omits LittleCMS. Profiled sources still require
    # normal color conversion and are handled by the server fallback.
    SRGB = None

def number(value, low, high, default=0):
    try: value=float(value)
    except (TypeError,ValueError): return default
    return max(low,min(high,value)) if math.isfinite(value) else default

def rgb(value):
    try:
        if len(value)!=7 or value[0]!='#': raise ValueError()
        return tuple(int(value[i:i+2],16) for i in (1,3,5))
    except (TypeError,ValueError,KeyError,IndexError): return (230,190,170)

def normalize_image(image):
    # exif_transpose copies even an already oriented 80MP image. Only transpose
    # when needed, and return one independent buffer before the opened file closes.
    oriented=ImageOps.exif_transpose(image) if image.getexif().get(274) in {2,3,4,5,6,7,8} else image
    try:
        profile=oriented.info.get('icc_profile')
        if profile:
            import io
            return ImageCms.profileToProfile(oriented,ImageCms.ImageCmsProfile(io.BytesIO(profile)),ImageCms.createProfile('sRGB'),outputMode='RGBA')
        return oriented.convert('RGBA')
    finally:
        if oriented is not image:oriented.close()

def _validate_tree(value, depth=0):
    if depth > 20:
        raise ValueError('요청 데이터가 너무 깊습니다.')
    if isinstance(value, dict):
        if len(value) > 128 or any(not isinstance(key, str) for key in value):
            raise ValueError('요청 객체가 올바르지 않습니다.')
        for item in value.values():
            _validate_tree(item, depth + 1)
    elif isinstance(value, list):
        if len(value) > 100000:
            raise ValueError('요청 배열이 너무 큽니다.')
        for item in value:
            _validate_tree(item, depth + 1)
    elif isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError('유한한 숫자만 사용할 수 있습니다.')
    elif isinstance(value, int) and not isinstance(value, bool):
        if abs(value) > 10**18:
            raise ValueError('숫자 범위를 벗어났습니다.')
    elif value is not None and not isinstance(value, (str, bool)):
        raise ValueError('요청 데이터가 올바르지 않습니다.')
    elif isinstance(value, str) and len(value) > 65536:
        raise ValueError('문자열이 너무 깁니다.')


def _validate_points(stroke):
    if not isinstance(stroke, dict):
        raise ValueError('브러시 기록이 올바르지 않습니다.')
    points = stroke.get('points', [])
    if not isinstance(points, list):
        raise ValueError('브러시 기록이 올바르지 않습니다.')
    for point in points:
        if (not isinstance(point, list) or len(point) != 2 or
                any(isinstance(value, bool) or not isinstance(value, (int, float)) or
                    not math.isfinite(value) or abs(value) > 1e6 for value in point)):
            raise ValueError('좌표가 올바르지 않습니다.')
    return len(points)


def validate_side(side):
    if not isinstance(side, dict):
        raise ValueError('보정 요청이 올바르지 않습니다.')
    _validate_tree(side)
    layers = side.get('layers', [])
    if not isinstance(layers, list) or len(layers) > 40:
        raise ValueError('레이어는 한 면당 최대 40개입니다.')
    ids = set()
    point_count = 0
    stroke_count = 0
    for layer in layers:
        if (not isinstance(layer, dict) or not isinstance(layer.get('type'), str) or
                layer.get('type') not in KINDS):
            raise ValueError('지원하지 않는 보정 레이어입니다.')
        layer_id = layer.get('id')
        if not isinstance(layer_id, str) or not layer_id or len(layer_id) > 100 or layer_id in ids:
            raise ValueError('레이어 ID가 올바르지 않습니다.')
        ids.add(layer_id)
        if 'visible' in layer and not isinstance(layer['visible'], bool):
            raise ValueError('레이어 표시 여부가 올바르지 않습니다.')
        params = layer.get('params', {})
        if not isinstance(params, dict):
            raise ValueError('레이어 설정이 올바르지 않습니다.')
        if len(params) > 64:
            raise ValueError('레이어 설정이 너무 많습니다.')
        allowed_modes = LIQUIFY_MODES if layer['type'] == 'liquify' else BLEND_MODES
        if ('mode' in params and
                (not isinstance(params['mode'], str) or params['mode'] not in allowed_modes)):
            raise ValueError('지원하지 않는 혼합 모드입니다.')
        if layer['type'] == 'tone' and 'vibrance' in params:
            vibrance = params['vibrance']
            if (isinstance(vibrance, bool) or not isinstance(vibrance, (int, float)) or
                    not math.isfinite(vibrance) or not -100 <= vibrance <= 100):
                raise ValueError('생동감 값은 -100부터 100 사이의 숫자여야 합니다.')
        strokes = layer.get('strokes', [])
        mask = layer.get('mask', {})
        if not isinstance(strokes, list) or not isinstance(mask, dict):
            raise ValueError('브러시 기록이 올바르지 않습니다.')
        mask_strokes = mask.get('strokes', [])
        if not isinstance(mask_strokes, list):
            raise ValueError('마스크 기록이 올바르지 않습니다.')
        stroke_count += len(strokes) + len(mask_strokes)
        for stroke in strokes:
            point_count += _validate_points(stroke)
            if 'brush' in stroke:
                if layer['type'] != 'paint' or stroke['brush'] != 'airbrush':
                    raise ValueError('지원하지 않는 브러시입니다.')
                flow = stroke.get('flow', .04)
                if (isinstance(flow, bool) or not isinstance(flow, (int, float)) or
                        not math.isfinite(flow) or not 0 <= flow <= 1):
                    raise ValueError('에어브러시 흐름은 0부터 1 사이의 숫자여야 합니다.')
                radius = stroke.get('radius', 80)
                if (isinstance(radius, bool) or not isinstance(radius, (int, float)) or
                        not math.isfinite(radius) or not 1 <= radius <= 800):
                    raise ValueError('에어브러시 반경은 1부터 800 사이의 숫자여야 합니다.')
            stroke_mode = stroke.get('mode', 'push')
            if (layer['type'] == 'liquify' and
                    (not isinstance(stroke_mode, str) or stroke_mode not in LIQUIFY_MODES)):
                raise ValueError('지원하지 않는 변형 모드입니다.')
            if layer['type'] == 'clone' and 'source' in stroke:
                source = stroke['source']
                if (not isinstance(source, list) or len(source) != 2 or
                        any(isinstance(value, bool) or not isinstance(value, (int, float)) or
                            not math.isfinite(value) or abs(value) > 1e6 for value in source)):
                    raise ValueError('복제 원본 좌표가 올바르지 않습니다.')
        for stroke in mask_strokes:
            point_count += _validate_points(stroke)
            if 'brush' in stroke:
                raise ValueError('브러시 구분자는 페인트 획에서만 사용할 수 있습니다.')
        shape = mask.get('shape')
        if shape is not None:
            if (not isinstance(shape, dict) or not isinstance(shape.get('kind'), str) or
                    shape.get('kind') not in {'rect', 'ellipse'}):
                raise ValueError('마스크 모양이 올바르지 않습니다.')
            box = shape.get('box')
            if (not isinstance(box, list) or len(box) != 4 or
                    any(isinstance(value, bool) or not isinstance(value, (int, float)) or
                        not math.isfinite(value) or abs(value) > 1e6 for value in box) or
                    box[0] >= box[2] or box[1] >= box[3]):
                raise ValueError('마스크 영역이 올바르지 않습니다.')
    if stroke_count > 5000:
        raise ValueError('브러시 기록 배열 한도를 넘었습니다.')
    if point_count > 100000:
        raise ValueError('한 면의 브러시 기록 한도를 넘었습니다. 출력본을 새 원본으로 열어 계속할 수 있습니다.')

def dabs(points, radius):
    if not points:return
    yield points[0]
    for a,b in zip(points,points[1:]):
        n=max(1,min(1000,math.ceil(math.dist(a,b)/max(1,radius*.22))))
        for i in range(1,n+1):yield (a[0]+(b[0]-a[0])*i/n,a[1]+(b[1]-a[1])*i/n)

def airbrush_dabs(points, radius):
    """Sample by document-space arc length so pointer event density cannot change a stroke."""
    if not points:return
    yield points[0]
    spacing=max(1,radius*.2)
    remaining=spacing
    for a,b in zip(points,points[1:]):
        length=math.dist(a,b)
        if length==0:
            # Repeated events are dwell pulses; keep the next arc-length sample in place.
            yield b
            continue
        dx=(b[0]-a[0])/length;dy=(b[1]-a[1])/length
        distance=remaining
        while distance<=length+1e-9:
            distance=min(distance,length)
            yield (a[0]+dx*distance,a[1]+dy*distance)
            distance+=spacing
        remaining=distance-length

def stroke_patch(size,stroke,scale,origin):
    """Only allocate the brush bounding box, including its feather."""
    points=[((p[0]-origin[0])*scale,(p[1]-origin[1])*scale) for p in stroke.get('points',[])]
    if not points:return None
    radius=max(.5,number(stroke.get('radius'),1,800,80)*scale)
    hardness=number(stroke.get('hardness'),0,1,.3)
    feather=radius*(1-hardness)*.25;halo=math.ceil(feather*4)+3
    min_x=min(p[0] for p in points);min_y=min(p[1] for p in points)
    max_x=max(p[0] for p in points);max_y=max(p[1] for p in points)
    left=max(-halo,math.floor(min_x-radius-halo));top=max(-halo,math.floor(min_y-radius-halo))
    right=min(size[0]+halo,math.ceil(max_x+radius+halo));bottom=min(size[1]+halo,math.ceil(max_y+radius+halo))
    if right<=left or bottom<=top:return None
    clipped=(max(0,left),max(0,top),min(size[0],right),min(size[1],bottom))
    if clipped[2]<=clipped[0] or clipped[3]<=clipped[1]:return None
    rr=max(.5,radius*(.45+.55*hardness))
    # Preserve the public patch box and the original rasterization origin.
    # Only the inner buffer fed to the feather filter needs to be tight.
    draw_left=max(left,math.floor(min_x-rr-halo));draw_top=max(top,math.floor(min_y-rr-halo))
    draw_right=min(right,math.ceil(max_x+rr+halo));draw_bottom=min(bottom,math.ceil(max_y+rr+halo))
    result=Image.new('L',(clipped[2]-clipped[0],clipped[3]-clipped[1]))
    if draw_right<=draw_left or draw_bottom<=draw_top:return clipped,result
    with Image.new('L',(draw_right-draw_left,draw_bottom-draw_top)) as patch:
        draw=ImageDraw.Draw(patch)
        dx,dy=draw_left-left,draw_top-top
        for x,y in dabs(points,radius):
            draw.ellipse((int(x-left-rr)-dx,int(y-top-rr)-dy,int(x-left+rr)-dx,int(y-top+rr)-dy),fill=255)
        filtered=patch.filter(ImageFilter.GaussianBlur(feather)) if hardness<1 else patch
        try:
            result.paste(filtered,(draw_left-clipped[0],draw_top-clipped[1]))
        finally:
            if filtered is not patch:filtered.close()
    return clipped,result

def mask_image(layer,size,scale,origin,cache=None):
    spec=layer.get('mask',{});strokes=spec.get('strokes',[])
    shape=spec.get('shape')
    if shape and not strokes:
        out=Image.new('L',size,0)
        if spec.get('base',1):
            draw=ImageDraw.Draw(out)
            x0,y0,x1,y1=shape['box']
            box=[(x0-origin[0])*scale,(y0-origin[1])*scale,
                 (x1-origin[0])*scale,(y1-origin[1])*scale]
            (draw.ellipse if shape.get('kind')=='ellipse' else draw.rectangle)(box,fill=255)
        return out
    out=None;start=0;full_key=None;prefix_key=None;prefix_hit=False
    if cache is not None and strokes:
        def key(records):
            digest=hashlib.sha256(json.dumps(records,sort_keys=True,separators=(',',':')).encode()).digest()
            return tuple(size),scale,tuple(origin),bool(spec.get('base',1)),digest
        full_key=key(strokes);cached=cache.get(full_key)
        if cached is not None:
            out=cached.copy();start=len(strokes)
        elif len(strokes)>1:
            # During a drag only the final stroke grows. The completed strokes
            # underneath it are shared with the preceding preview/undo state.
            prefix_key=key(strokes[:-1]);cached=cache.get(prefix_key)
            if cached is not None:
                out=cached.copy();start=len(strokes)-1;prefix_hit=True
    if out is None:out=Image.new('L',size,255 if spec.get('base',1) else 0)
    for index in range(start,len(strokes)):
        if prefix_key is not None and index==len(strokes)-1 and not prefix_hit:
            cache.store(prefix_key,out.copy())
        stroke=strokes[index]
        amount=number(stroke.get('opacity',1),0,1,1)
        if amount==0 or not stroke.get('points'):continue
        result=stroke_patch(size,stroke,scale,origin)
        if result:
            box,patch=result
            try:
                if amount<1:
                    attenuated=patch.point(lambda v:round(v*amount));patch.close();patch=attenuated
                out.paste(0 if stroke.get('erase') else 255,box,patch)
            finally:patch.close()
    if full_key is not None and start<len(strokes):cache.store(full_key,out.copy())
    shape=spec.get('shape')
    if shape:
        gate=Image.new('L',size);draw=ImageDraw.Draw(gate)
        x0,y0,x1,y1=shape['box'];box=[(x0-origin[0])*scale,(y0-origin[1])*scale,(x1-origin[0])*scale,(y1-origin[1])*scale]
        (draw.ellipse if shape.get('kind')=='ellipse' else draw.rectangle)(box,fill=255)
        from PIL import ImageChops
        gated=ImageChops.multiply(out,gate);out.close();gate.close();out=gated
    return out

def soft_light(a,b):
    d=np.where(a<=.25,((16*a-12)*a+4)*a,np.sqrt(a))
    return np.where(b<=.5,a-(1-2*b)*a*(1-a),a+(2*b-1)*(d-a))

def color_blend(a,b):
    lum=lambda c:(c*np.array([.3,.59,.11],dtype=np.float32)).sum(axis=2,keepdims=True)
    c=np.broadcast_to(b,a.shape).copy();c+=lum(a)-lum(c)
    l=lum(c);mn=c.min(axis=2,keepdims=True);mx=c.max(axis=2,keepdims=True)
    c=np.where(mn<0,l+(c-l)*l/np.maximum(l-mn,1e-6),c)
    c=np.where(mx>1,l+(c-l)*(1-l)/np.maximum(mx-l,1e-6),c)
    return np.clip(c,0,1)

def vibrance_adjust(c,amount):
    """Raise or lower low-chroma color while preserving W3C luma where in gamut."""
    weights=np.array([.3,.59,.11],dtype=np.float32)
    # Reduce the three channels directly, avoiding repeated RGB-sized temporary
    # arrays and slow strided reductions on an 80MP correction.
    def minimum(values):return np.minimum(np.minimum(values[...,0],values[...,1]),values[...,2])[...,None]
    def maximum(values):return np.maximum(np.maximum(values[...,0],values[...,1]),values[...,2])[...,None]
    l=(c[...,0]*weights[0]+c[...,1]*weights[1]+c[...,2]*weights[2])[...,None]
    saturation=maximum(c)-minimum(c)
    factor=1+amount/100*(1-saturation)
    c=l+(c-l)*factor
    low=minimum(c);high=maximum(c)
    below=low[...,0]<0;above=high[...,0]>1
    if np.any(below):
        light=l[below]
        c[below]=light+(c[below]-light)*np.clip(light,0,1)/np.maximum(light-low[below],1e-6)
    if np.any(above):
        light=l[above]
        c[above]=light+(c[above]-light)*(1-np.clip(light,0,1))/np.maximum(high[above]-light,1e-6)
    return np.clip(c,0,1)

_native_normal_blend = None  # Installed only by the browser worker.

def composite(base,changed,mask,opacity=1,mode='normal'):
    if mode=='normal' and opacity==1 and mask.getextrema()==(255,255):
        # Avoid several float RGBA buffers when the whole tile is replaced.
        result=changed.copy()
        with base.getchannel('A') as alpha:result.putalpha(alpha)
        return result
    if mode=='normal' and opacity==1 and base.mode=='RGBA' and changed.mode=='RGBA' and mask.mode=='L':
        # Pillow's native masked paste has the same byte rounding as the float32
        # blend here, and avoids allocating several full-tile float buffers.
        result=base.copy()
        result.paste(changed,(0,0),mask)
        with base.getchannel('A') as alpha:result.putalpha(alpha)
        return result
    if mode=='normal' and base.mode=='RGBA' and changed.mode=='RGBA' and mask.mode=='L':
        if _native_normal_blend is not None:
            source = np.asarray(base)
            edit = np.asarray(changed)
            strength = np.asarray(mask)
            output = np.empty_like(source)
            _native_normal_blend(source.ctypes.data, edit.ctypes.data, strength.ctypes.data,
                                 output.ctypes.data, base.width * base.height, opacity)
            return Image.fromarray(output)
        # Work on contiguous color planes and copy alpha directly from the base.
        base_pixels = np.asarray(base)
        a = np.ascontiguousarray(np.moveaxis(base_pixels[..., :3], -1, 0), dtype=np.float32) / 255
        b = np.ascontiguousarray(np.moveaxis(np.asarray(changed)[..., :3], -1, 0), dtype=np.float32) / 255
        strength = np.asarray(mask, dtype=np.float32) / 255 * opacity
        a += (b - a) * strength[None, ...]
        pixels = base_pixels.copy()
        pixels[..., :3] = np.moveaxis(np.clip(a * 255 + .5, 0, 255).astype('uint8'), 0, -1)
        return Image.fromarray(pixels)
    a=np.asarray(base,dtype=np.float32)/255;b=np.asarray(changed,dtype=np.float32)/255
    strength=np.asarray(mask,dtype=np.float32)[...,None]/255*opacity
    if mode=='soft-light':b[...,:3]=soft_light(a[...,:3],b[...,:3])
    elif mode=='color':b[...,:3]=color_blend(a[...,:3],b[...,:3])
    elif mode=='multiply':b[...,:3]=a[...,:3]*b[...,:3]
    elif mode=='screen':b[...,:3]=1-(1-a[...,:3])*(1-b[...,:3])
    # Source alpha is preserved: corrections do not fill transparent margins.
    a[...,:3]+= (b[...,:3]-a[...,:3])*strength
    return Image.fromarray(np.clip(a*255+.5,0,255).astype('uint8'))

def perlin(width,height,origin,scale,cell,seed):
    x=(np.arange(width,dtype=np.float32)/scale+origin[0])[None,:]/cell
    y=(np.arange(height,dtype=np.float32)/scale+origin[1])[:,None]/cell
    ix=np.floor(x);iy=np.floor(y);fx=x-ix;fy=y-iy
    fade=lambda t:t*t*t*(t*(t*6-15)+10)
    u=fade(fx);v=fade(fy)
    # Each lattice gradient is shared by many pixels. Evaluate trigonometry
    # once per cell, then gather it without changing document-space coordinates.
    cells_x,index_x=np.unique(ix[0],return_inverse=True)
    cells_y,index_y=np.unique(iy[:,0],return_inverse=True)
    def gradient(dx,dy):
        angle=np.mod(np.sin((cells_x[None,:]+dx)*127.1+(cells_y[:,None]+dy)*311.7+seed*17.13)*43758.5453,1)*math.tau
        cosine=np.cos(angle)[index_y[:,None],index_x[None,:]]
        sine=np.sin(angle)[index_y[:,None],index_x[None,:]]
        return cosine*(fx-dx)+sine*(fy-dy)
    return (gradient(0,0)*(1-u)+gradient(1,0)*u)*(1-v)+(gradient(0,1)*(1-u)+gradient(1,1)*u)*v

def _tone_tile(tile, params):
    brightness = number(params.get('brightness'), -40, 40) / 100
    contrast = number(params.get('contrast'), -70, 70) / 100
    saturation = number(params.get('saturation'), -100, 100) / 100
    shadows = number(params.get('shadows'), -40, 40) / 100
    highlights = number(params.get('highlights'), -40, 40) / 100
    vibrance = number(params.get('vibrance'), -100, 100, 0)
    needs_color = saturation or shadows or highlights or vibrance
    lookup = tile.mode == 'RGBA' and not needs_color
    if lookup:
        # Brightness and contrast transform each byte independently.
        channels = np.arange(256, dtype=np.float32) / 255
    else:
        source = np.asarray(tile)
        channels = np.ascontiguousarray(np.moveaxis(source[..., :3], -1, 0), dtype=np.float32) / 255
    channels = (channels - .5) * (1 + contrast) + .5 + brightness
    if needs_color:
        # The previous RGB-array formula promoted luma math to float64, including on NumPy 1.x.
        channels = channels.astype(np.float64)
    if saturation or shadows or highlights:
        luma = (channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722)[None, ...]
        channels = luma + (channels - luma) * (1 + saturation)
        clipped = np.clip(luma, 0, 1)
        channels += shadows * (1 - clipped)**3 + highlights * clipped**3
    if vibrance:
        channels = np.moveaxis(vibrance_adjust(np.moveaxis(channels, 0, -1), vibrance), -1, 0)
    adjusted = np.clip(channels, 0, 1).astype(np.float32, copy=False)
    values = np.clip(adjusted * 255 + .5, 0, 255).astype('uint8')
    if lookup:
        return tile.point(values.tolist() * 3 + list(range(256)))
    pixels = source.copy()
    pixels[..., :3] = np.moveaxis(values, 0, -1)
    return Image.fromarray(pixels)

_native_gaussian = None


def changed_tile(tile,kind,p,origin,scale):
    if kind=='color':return Image.new('RGBA',tile.size,rgb(p.get('color','#ffe0cd'))+(255,))
    if kind in {'blur','sharpen'}:
        radius=number(p.get('radius'),.1,40,3 if kind=='blur' else 5)*scale
        percent=-1 if kind=='blur' else int(number(p.get('amount'),0,250,100))
        threshold=int(number(p.get('threshold'),0,50,0))
        if _native_gaussian is not None and tile.mode=='RGBA' and 0<radius<=40:
            changed=_native_gaussian(tile,radius,percent,threshold)
            if changed is not None:return changed
        return tile.filter(ImageFilter.GaussianBlur(radius) if percent<0 else
                           ImageFilter.UnsharpMask(radius,percent,threshold))
    if kind=='tone':return _tone_tile(tile,p)
    a=np.asarray(tile,dtype=np.float32)/255;c=a[...,:3]
    if kind=='line':
        edge=np.asarray(tile.convert('L').filter(ImageFilter.FIND_EDGES),dtype=np.float32)/255
        c=c*(1-np.clip(edge*number(p.get('strength'),.1,5,1.5),0,1)[...,None])
    elif kind=='texture':
        noise=np.zeros((tile.height,tile.width),np.float32);total=0
        cell=number(p.get('scale'),2,500,100);decay=number(p.get('decay'),.1,.9,.4)
        for octave in range(int(number(p.get('octaves'),1,4,3))):
            weight=decay**octave;seed=int(number(p.get('seed',17),-1000000,1000000,17));noise+=perlin(tile.width,tile.height,origin,scale,cell/2**octave,seed)*weight;total+=weight
        n=np.clip(.5+noise/total,0,1)[...,None];c=soft_light(c,n)
    a[...,:3]=np.clip(c,0,1)
    return Image.fromarray(np.clip(a*255+.5,0,255).astype('uint8'))

def _color_table(layer):
    """Channel-independent blends have only 256 input x 256 mask values."""
    p=layer.get('params',{});mode=p.get('mode','normal')
    if layer['type']!='color' or mode=='color':return None
    pixels=np.empty((256,256,4),dtype=np.uint8)
    pixels[...,:3]=np.arange(256,dtype=np.uint8)[None,:,None];pixels[...,3]=255
    mask_values=np.broadcast_to(np.arange(256,dtype=np.uint8)[:,None],(256,256)).copy()
    # Use the existing compositor, including its float32 rounding. This table
    # changes the amount of work, not the blend or eraser strength.
    with Image.fromarray(pixels) as base, Image.fromarray(mask_values) as mask:
        with changed_tile(base,'color',p,(0,0),1) as changed:
            with composite(base,changed,mask,number(layer.get('opacity'),0,1,1),mode) as result:
                return np.asarray(result)[...,:3].copy()

def tone_prefix_table(layers):
    """Compose independent byte mappings without storing another full RGBA image."""
    if not layers:return None
    for layer in layers:
        mask=layer.get('mask',{});p=layer.get('params',{})
        if (layer['type']!='tone' or number(layer.get('opacity'),0,1,1)!=1 or
                not mask.get('base',1) or mask.get('strokes') or mask.get('shape') or
                p.get('mode','normal')!='normal' or
                any(number(p.get(key),-100,100) for key in ('saturation','vibrance','shadows','highlights'))):
            return None
    ramp=Image.frombytes('RGBA',(256,1),bytes(value for v in range(256) for value in (v,v,v,255)))
    try:
        for layer in layers:
            transformed=_tone_tile(ramp,layer.get('params',{}))
            ramp.close()
            ramp=transformed
        with ramp.getchannel('R') as red:
            return list(red.tobytes())*3+list(range(256))
    finally:
        ramp.close()

def _adjustment_crop(image,box,source_lut):
    crop=image.crop(box)
    if source_lut is None:return crop
    with crop:return crop.point(source_lut)

def iter_adjustment(image,layer,scale,origin,progress=None,prepared_mask=None,source_image=None,
                    compact_tiles=False,source_lut=None):
    kind=layer['type'];p=layer.get('params',{});opacity=number(layer.get('opacity'),0,1,1)
    # Read each neighborhood from the pre-layer image; tile edges never become filter edges.
    needs_source=kind in {'blur','sharpen','line'}
    source=source_image
    color_table=_color_table(layer)
    pad=math.ceil(number(p.get('radius'),0,40,5)*scale*4)+4 if needs_source else 0
    # The viewport/streaming caller has already padded this bounded crop.
    # Avoid filtering the same halo repeatedly for tiny remainder tiles.
    tile_size=max(image.size) if compact_tiles and image.width*image.height<=1_048_576 else 768
    try:
        for y in range(0,image.height,tile_size):
            for x in range(0,image.width,tile_size):
                box=(x,y,min(image.width,x+tile_size),min(image.height,y+tile_size))
                with (prepared_mask.crop(box) if prepared_mask is not None else
                      mask_image(layer,(box[2]-x,box[3]-y),scale,(origin[0]+x/scale,origin[1]+y/scale))) as mask:
                    if not mask.getbbox():
                        if source_image is not None:
                            with _adjustment_crop(source_image,box,source_lut) as base:image.paste(base,box)
                        yield
                        continue
                    if color_table is not None:
                        with _adjustment_crop(source_image if source_image is not None else image,box,source_lut) as base:
                            pixels=np.array(base)
                        strength=np.asarray(mask)
                        for channel in range(3):pixels[...,channel]=color_table[strength,pixels[...,channel],channel]
                        with Image.fromarray(pixels) as result:image.paste(result,box)
                        yield
                        continue
                    if source is None:source=image.copy() if needs_source else image
                    if pad==0:
                        start=(origin[0]+x/scale,origin[1]+y/scale)
                        with _adjustment_crop(source,box,source_lut) as tile, changed_tile(tile,kind,p,start,scale) as changed:
                            if kind=='tone' and opacity==1 and p.get('mode','normal')=='normal' and mask.getextrema()==(255,255):
                                # Tone already preserves each original alpha byte.
                                image.paste(changed,box)
                            else:
                                with composite(tile,changed,mask,opacity,p.get('mode','normal')) as result:
                                    image.paste(result,box)
                    else:
                        expanded=(max(0,x-pad),max(0,y-pad),min(image.width,box[2]+pad),min(image.height,box[3]+pad))
                        start=(origin[0]+expanded[0]/scale,origin[1]+expanded[1]/scale)
                        inner=(x-expanded[0],y-expanded[1],box[2]-expanded[0],box[3]-expanded[1])
                        with _adjustment_crop(source,expanded,source_lut) as tile, changed_tile(tile,kind,p,start,scale) as changed:
                            with tile.crop(inner) as base, changed.crop(inner) as correction:
                                if (opacity==1 and p.get('mode','normal')=='normal' and
                                        mask.getextrema()==(255,255) and base.mode=='RGBA' and correction.mode=='RGBA'):
                                    # The correction crop is temporary, so restore alpha in-place
                                    # instead of copying it again through composite().
                                    with base.getchannel('A') as alpha:correction.putalpha(alpha)
                                    image.paste(correction,box)
                                else:
                                    with composite(base,correction,mask,opacity,p.get('mode','normal')) as result:
                                        image.paste(result,box)
                yield
            if progress:progress(min(1,(y+tile_size)/image.height))
    finally:
        if source is not None and source is not image and source is not source_image:source.close()

def apply_adjustment(image,layer,scale,origin,progress=None,prepared_mask=None,source_image=None):
    for _ in iter_adjustment(image,layer,scale,origin,progress,prepared_mask,source_image):
        pass

def sample_bilinear(pixels,x,y):
    x=np.clip(x,0,pixels.shape[1]-1);y=np.clip(y,0,pixels.shape[0]-1)
    x0=np.floor(x).astype(np.int32);y0=np.floor(y).astype(np.int32)
    x1=np.minimum(x0+1,pixels.shape[1]-1);y1=np.minimum(y0+1,pixels.shape[0]-1)
    fx=(x-x0)[...,None];fy=(y-y0)[...,None]
    return (pixels[y0,x0]*(1-fx)+pixels[y0,x1]*fx)*(1-fy)+(pixels[y1,x0]*(1-fx)+pixels[y1,x1]*fx)*fy

def apply_liquify(image,layer,scale,origin,*,native_crop=False,skip_initial=False):
    # A bounded native update still evaluates every sample in document-space
    # float32 coordinates, including fractional brush centers far from (0, 0).
    left,top=origin if native_crop else (0,0)
    right,bottom=left+image.width,top+image.height
    for stroke in layer.get('strokes',[]):
        radius=max(1,number(stroke.get('radius'),1,800,80)*scale)
        strength=number(stroke.get('strength'),.01,1,.35);mode=stroke.get('mode','push')
        points=[tuple(p) if native_crop else ((p[0]-origin[0])*scale,(p[1]-origin[1])*scale)
                for p in stroke.get('points',[])]
        if not points:continue
        last=points[0]
        samples=dabs(points,radius)
        if skip_initial:next(samples,None)
        for cx,cy in samples:
            dx=cx-last[0];dy=cy-last[1];last=(cx,cy)
            if mode=='push' and dx==dy==0:continue
            box=(max(left,int(cx-radius-3)),max(top,int(cy-radius-3)),
                 min(right,math.ceil(cx+radius+3)),min(bottom,math.ceil(cy+radius+3)))
            if box[2]<=box[0] or box[3]<=box[1]:continue
            yy,xx=np.mgrid[box[1]:box[3],box[0]:box[2]].astype(np.float32)
            rx=xx-cx;ry=yy-cy;f=np.maximum(0,1-(rx*rx+ry*ry)/(radius*radius))**2
            sx=xx.copy();sy=yy.copy()
            if mode=='push':sx-=dx*strength*f;sy-=dy*strength*f
            elif mode in {'expand','shrink'}:
                k=(1 if mode=='shrink' else -1)*strength*.14*f;sx+=rx*k;sy+=ry*k
            else:
                angle=strength*.22*f*(1 if mode=='clockwise' else -1);co=np.cos(angle);si=np.sin(angle)
                sx=cx+co*rx+si*ry;sy=cy-si*rx+co*ry
            # Include displaced source pixels beyond the affected circle.
            sb=(max(left,int(sx.min())-2),max(top,int(sy.min())-2),
                min(right,math.ceil(sx.max())+3),min(bottom,math.ceil(sy.max())+3))
            local_box=(box[0]-left,box[1]-top,box[2]-left,box[3]-top)
            local_source=(sb[0]-left,sb[1]-top,sb[2]-left,sb[3]-top)
            with image.crop(local_source) as source:
                sampled=sample_bilinear(np.asarray(source,dtype=np.float32),sx-sb[0],sy-sb[1])
            with image.crop(local_box) as tile, Image.fromarray(np.clip(sampled+.5,0,255).astype('uint8')) as warped:
                start=(origin[0]+local_box[0]/scale,origin[1]+local_box[1]/scale)
                with mask_image(layer,tile.size,scale,start) as mask:
                    with composite(tile,warped,mask,number(layer.get('opacity'),0,1,1)) as result:
                        image.paste(result,local_box)

def clone_region(original, size, sourcebox):
    """Keep Pillow's bicubic RGBA transform within the source brush footprint."""
    x0, y0, x1, y1 = sourcebox
    # With an integral unit mapping and a full 3px source margin, bicubic
    # sampling selects only the corresponding pixel. Pillow still premultiplies
    # RGBA while resampling, so retain its exact byte rounding through RGBa.
    if (all(float(value).is_integer() for value in sourcebox) and
            x1 - x0 == size[0] and y1 - y0 == size[1] and
            x0 >= 3 and y0 >= 3 and x1 <= original.width - 3 and y1 <= original.height - 3):
        with original.crop((int(x0),int(y0),int(x1),int(y1))) as source:
            with source.getchannel('A') as alpha:
                if alpha.getextrema()==(255,255):return source.copy()
            with source.convert('RGBa') as premultiplied:
                return premultiplied.convert('RGBA')
    left, top = max(0, math.floor(x0) - 3), max(0, math.floor(y0) - 3)
    right, bottom = min(original.width, math.ceil(x1) + 3), min(original.height, math.ceil(y1) + 3)
    if right <= left or bottom <= top:
        return Image.new(original.mode, size)
    # EXTENT internally uses this affine transform. Preserve its scale and
    # image-edge clipping while avoiding premultiplication of the entire source.
    transform = ((x1 - x0) / size[0], 0, x0 - left, 0, (y1 - y0) / size[1], y0 - top)
    with original.crop((left, top, right, bottom)) as source:
        return source.transform(size, Image.Transform.AFFINE, transform, Image.Resampling.BICUBIC)


def _paint_mask_is_identity(layer):
    spec=layer.get('mask',{})
    return bool(spec.get('base',1)) and not spec.get('strokes') and not spec.get('shape')


def _paint_mask_is_empty(layer):
    spec=layer.get('mask',{})
    if spec.get('base',1):return False
    return not any(
        not stroke.get('erase') and stroke.get('points') and
        number(stroke.get('opacity',1),0,1,1)>0
        for stroke in spec.get('strokes',[])
    )


def _trim_paint_patch(patch,box,start,scale):
    """Drop zero-only borders after layer/source alpha has limited a stroke."""
    support=patch.getbbox()
    if support is None:
        patch.close()
        return None
    if support==(0,0,patch.width,patch.height):
        return patch,box,start,support
    cropped=patch.crop(support)
    patch.close()
    return (cropped,
            (box[0]+support[0],box[1]+support[1],box[0]+support[2],box[1]+support[3]),
            (start[0]+support[0]/scale,start[1]+support[1]/scale),support)


def apply_paint(image,layer,scale,origin,original):
    layer_opacity=number(layer.get('opacity'),0,1,1)
    if layer_opacity==0 or _paint_mask_is_empty(layer):return
    mask_identity=_paint_mask_is_identity(layer)
    mode=layer.get('params',{}).get('mode','normal')
    from PIL import ImageChops
    for stroke in layer.get('strokes',[]):
        if stroke.get('brush')=='airbrush':
            flow=number(stroke.get('flow'),0,1,.04)
            opacity=number(stroke.get('opacity'),0,1,.1)*layer_opacity
            if flow==0 or opacity==0:continue
            result=airbrush_coverage(image.size,stroke,scale,origin)
            if not result:continue
            box,coverage=result;start=(origin[0]+box[0]/scale,origin[1]+box[1]/scale)
            if not mask_identity:
                with mask_image(layer,(box[2]-box[0],box[3]-box[1]),scale,start) as mask:
                    coverage*=np.asarray(mask,dtype=np.float32)/255
            patch=Image.fromarray(np.clip(coverage*255+.5,0,255).astype('uint8'),'L')
            support=patch.getbbox()
            if support is None:
                patch.close()
                continue
            if support!=(0,0,patch.width,patch.height):
                cropped=patch.crop(support);patch.close();patch=cropped
                box=(box[0]+support[0],box[1]+support[1],box[0]+support[2],box[1]+support[3])
            with patch, Image.new('RGBA',patch.size,rgb(stroke.get('color','#e6baa4'))+(255,)) as color:
                with image.crop(box) as base, composite(base,color,patch,opacity,mode) as result:
                    image.paste(result,box)
            continue
        opacity=number(stroke.get('opacity'),0,1,.1)*layer_opacity
        if opacity==0:continue
        if layer['type']=='clone' and (not stroke.get('source') or not stroke.get('points')):
            continue
        result=stroke_patch(image.size,stroke,scale,origin)
        if not result:continue
        box,patch=result;start=(origin[0]+box[0]/scale,origin[1]+box[1]/scale)
        if not mask_identity:
            with mask_image(layer,patch.size,scale,start) as mask:
                masked=ImageChops.multiply(patch,mask)
            patch.close();patch=masked
        trimmed=_trim_paint_patch(patch,box,start,scale)
        if trimmed is None:continue
        patch,box,start,_support=trimmed
        if layer['type']=='clone':
            src=stroke['source'];points=stroke['points']
            delta=(src[0]-points[0][0],src[1]-points[0][1])
            sourcebox=(start[0]+delta[0],start[1]+delta[1],start[0]+delta[0]+patch.width/scale,start[1]+delta[1]+patch.height/scale)
            color=clone_region(original,patch.size,sourcebox)
            with color.getchannel('A') as alpha:
                masked=ImageChops.multiply(patch,alpha)
            patch.close();patch=masked
            trimmed=_trim_paint_patch(patch,box,start,scale)
            if trimmed is None:
                color.close()
                continue
            patch,new_box,start,support=trimmed
            if support!=(0,0,color.width,color.height):
                cropped=color.crop(support);color.close();color=cropped
            box=new_box
        else:color=Image.new('RGBA',patch.size,rgb(stroke.get('color','#e6baa4'))+(255,))
        try:
            with patch, color, image.crop(box) as base:
                with composite(base,color,patch,opacity,mode) as result:
                    image.paste(result,box)
        finally:
            # The context manager above owns both only on successful entry.
            patch.close();color.close()

def airbrush_coverage(size,stroke,scale,origin):
    """Accumulate soft, flowing dabs in a clipped stroke-sized float32 region."""
    points=stroke.get('points',[])
    if not points:return None
    radius_doc=number(stroke.get('radius'),1,800,80)
    radius=max(.5,radius_doc*scale)
    points_px=[((point[0]-origin[0])*scale,(point[1]-origin[1])*scale) for point in points]
    left=max(0,math.floor(min(point[0] for point in points_px)-radius-.5))
    top=max(0,math.floor(min(point[1] for point in points_px)-radius-.5))
    right=min(size[0],math.ceil(max(point[0] for point in points_px)+radius-.5)+1)
    bottom=min(size[1],math.ceil(max(point[1] for point in points_px)+radius-.5)+1)
    if right<=left or bottom<=top:return None
    coverage=np.zeros((bottom-top,right-left),dtype=np.float32)
    hardness=number(stroke.get('hardness'),0,1,.3)
    flow=number(stroke.get('flow'),0,1,.04)
    denominator=1-math.exp(-4.5)
    for point in airbrush_dabs(points,radius_doc):
        cx=(point[0]-origin[0])*scale;cy=(point[1]-origin[1])*scale
        x0=max(left,math.floor(cx-radius-.5));y0=max(top,math.floor(cy-radius-.5))
        x1=min(right,math.ceil(cx+radius-.5)+1);y1=min(bottom,math.ceil(cy+radius-.5)+1)
        if x1<=x0 or y1<=y0:continue
        target=coverage[y0-top:y1-top,x0-left:x1-left]
        yy=(np.arange(y0,y1,dtype=np.float32)+.5-cy)[:,None]
        xx=(np.arange(x0,x1,dtype=np.float32)+.5-cx)[None,:]
        t=np.hypot(xx,yy)/radius
        q=np.clip((t-hardness)/max(1-hardness,1e-6),0,1)
        falloff=(np.exp(-4.5*q*q)-math.exp(-4.5))/denominator
        falloff=np.where(t>=1,0,np.clip(falloff,0,1))
        target+=(1-target)*falloff*flow
    return (left,top,right,bottom),coverage

def context_halo(layers):
    halo=8
    for l in layers:
        if not l.get('visible',True):continue
        if l['type'] in {'blur','sharpen','line'}:halo+=math.ceil(number(l.get('params',{}).get('radius'),0,40,5)*4)+4
        if l['type']=='liquify':
            for s in l.get('strokes',[]):
                pts=s.get('points',[]);r=number(s.get('radius'),1,800,80)
                if s.get('mode','push')=='push':halo+=math.ceil(sum(math.dist(a,b) for a,b in zip(pts,pts[1:]))*number(s.get('strength'),0,1,.35))
                else:halo+=math.ceil(r*number(s.get('strength'),0,1,.35)*max(1,len(list(dabs(pts,r))))*.5)
    return halo

def _has_effect(layer):
    if not layer.get('visible',True) or number(layer.get('opacity'),0,1,1)==0:return False
    mask=layer.get('mask',{})
    if not mask.get('base',1) and not any(
            not stroke.get('erase') and stroke.get('points') and number(stroke.get('opacity',1),0,1,1)>0
            for stroke in mask.get('strokes',[])):
        return False
    if layer['type'] in {'paint','clone','liquify'} and not layer.get('strokes'):return False
    if layer['type']=='tone':
        params=layer.get('params',{})
        keys=('brightness','contrast','saturation','vibrance','shadows','highlights')
        if params.get('mode','normal')=='normal' and not any(number(params.get(key),-100,100) for key in keys):
            return False
    return True


def iter_layers(image,layers,scale,origin,original,progress=None,mask_cache=None,first_source=None,chunked=True):
    prepared_mask=None;prepared_spec=None
    try:
        for i,layer in enumerate(layers):
            name=layer.get('name',layer['type'])
            if progress:progress(i/len(layers),name)
            if layer['type']=='liquify':apply_liquify(image,layer,scale,origin,native_crop=scale==1)
            elif layer['type'] in {'paint','clone'}:apply_paint(image,layer,scale,origin,original)
            else:
                spec=layer.get('mask',{});mask=None
                if spec.get('strokes') or spec.get('shape'):
                    # Keep one byte-per-pixel mask for this render. Multiple selected
                    # corrections can share identical eraser records; neither tiles
                    # nor those layers need to replay the large soft strokes again.
                    if prepared_mask is None or spec!=prepared_spec:
                        if prepared_mask is not None:prepared_mask.close()
                        prepared_mask=None
                        prepared_mask=mask_image(layer,image.size,scale,origin,cache=mask_cache)
                        prepared_spec=spec
                    mask=prepared_mask
                report=(lambda value:progress((i+value)/len(layers),name)) if progress else None
                source=first_source if i==0 else None
                if chunked:
                    yield from iter_adjustment(image,layer,scale,origin,report,prepared_mask=mask,
                                               source_image=source,compact_tiles=True)
                else:
                    apply_adjustment(image,layer,scale,origin,report,prepared_mask=mask,source_image=source)
            if progress:progress((i+1)/len(layers),name)
            yield
    finally:
        if prepared_mask is not None:prepared_mask.close()

def _apply_layers(image,layers,scale,origin,original,progress=None,mask_cache=None,first_source=None,compact_tiles=False):
    for _ in iter_layers(image,layers,scale,origin,original,progress,mask_cache,first_source,chunked=compact_tiles):
        pass


def _render_layer_copy(prepared,layers,scale,origin,mask_cache=None,progress=None):
    image=prepared.copy()
    try:
        _apply_layers(image,layers,scale,origin,None,progress,mask_cache=mask_cache)
        return image
    except BaseException:
        image.close()
        raise


def _render_viewport_result(prepared,layers,scale,origin,crop,region_cache,progress=None):
    if (region_cache is not None and progress is None and
            region_cache.can_store_viewport(prepared.size)):
        rendered=region_cache.render_viewport_layers(
            prepared,layers,
            lambda base,pending:_render_layer_copy(
                base,pending,scale,origin,region_cache.masks,
            ),
        )
        return rendered.crop(crop)
    rendered=_render_layer_copy(
        prepared,layers,scale,origin,
        region_cache.masks if region_cache is not None else None,
        progress=progress,
    )
    try:
        return rendered.crop(crop)
    finally:
        rendered.close()


def render_preview(prepared,side,scale,mask_cache=None):
    """Render layers onto a borrowed, already-normalized preview without mutating it."""
    validate_side(side)
    if (isinstance(scale,bool) or not isinstance(scale,(int,float)) or
            not 0<scale<=1 or not math.isfinite(scale)):
        raise ValueError('미리보기 배율이 올바르지 않습니다.')
    layers=[layer for layer in side.get('layers',[]) if _has_effect(layer)]
    if any(layer['type']=='clone' for layer in layers):
        raise ValueError('복제 레이어는 원본 이미지 렌더링이 필요합니다.')
    return _render_layer_copy(prepared,layers,scale,(0,0),mask_cache)


def render(path,side,max_edge=None,region=None,progress=None,region_scale=None,
           region_cache=None,source_key=None,prepared_source=None,compact_tiles=False):
    validate_side(side)
    if prepared_source is not None and (region is None or not isinstance(prepared_source, Image.Image) or
                                       prepared_source.mode != 'RGBA'):
        raise ValueError('���� ��ó�� �����ϴ�.')
    if region_scale is not None:
        if (region is None or isinstance(region_scale,bool) or
                not isinstance(region_scale,(int,float)) or not 0<region_scale<=1 or
                not math.isfinite(region_scale)):
            raise ValueError('상세 영역 배율이 올바르지 않습니다.')
    layers=[layer for layer in side.get('layers',[]) if _has_effect(layer)]
    needs_original=any(layer['type']=='clone' for layer in layers)
    halo=context_halo(layers) if region else None
    use_region_cache=(region_cache is not None and source_key is not None and
                      region is not None and region_scale is not None and not needs_original)
    if use_region_cache:
        cached_region=region_cache.get_viewport(source_key,region,region_scale,halo)
        if cached_region is not None:
            prepared,origin,crop=cached_region
            return _render_viewport_result(
                prepared,layers,region_scale,origin,crop,region_cache,progress,
            )
    owns_original=prepared_source is None
    if owns_original:
        opened=Image.open(path)
        try:
            original=normalize_image(opened)
        finally:
            opened.close()
    else:
        original=prepared_source
    image=None
    try:
        scale=1;origin=(0,0)
        if max_edge:scale=min(1,max_edge/max(original.size))
        crop=None
        if region:
            x,y,w,h=region
            extent=(max(0,x-halo),max(0,y-halo),min(original.width,x+w+halo),min(original.height,y+h+halo))
            origin=extent[:2]
            image=original.crop(extent)
            if region_scale is not None:
                scale=region_scale
                if scale!=1:
                    with image:
                        image=image.resize((max(1,round(image.width*scale)),max(1,round(image.height*scale))),Image.Resampling.LANCZOS)
                crop_x=round((x-origin[0])*scale);crop_y=round((y-origin[1])*scale)
                crop_w=max(1,round(w*scale));crop_h=max(1,round(h*scale))
                # Rounding the origin and size independently can exceed a very
                # small resized context by one pixel; keep the requested tile in bounds.
                crop_x=min(max(0,crop_x),max(0,image.width-crop_w))
                crop_y=min(max(0,crop_y),max(0,image.height-crop_h))
                crop=(crop_x,crop_y,crop_x+crop_w,crop_y+crop_h)
            else:
                crop=(x-origin[0],y-origin[1],x+w-origin[0],y+h-origin[1])
            if not needs_original:
                if owns_original:
                    original.close()
                original=None
            cacheable_viewport=(use_region_cache and region_cache.can_store_viewport(image.size))
            if cacheable_viewport:
                if progress is None:
                    prepared=image
                    region_cache.store_viewport(
                        source_key,region,region_scale,halo,origin, crop,prepared,
                    )
                    image=None
                    return _render_viewport_result(
                        prepared,layers,region_scale,origin,crop,region_cache,
                    )
                region_cache.store_viewport(
                    source_key,region,region_scale,halo,origin,crop,image.copy(),
                )
        elif scale<1:image=original.resize((max(1,round(original.width*scale)),max(1,round(original.height*scale))),Image.Resampling.LANCZOS)
        else:image=original.copy() if needs_original or not owns_original else original
        if not needs_original:
            if owns_original and original is not None and image is not original:original.close()
            original=None
        used_viewport_layers=False
        if (region and use_region_cache and progress is None and
                region_cache.can_store_viewport(image.size)):
            rendered=region_cache.render_viewport_layers(
                image,layers,
                lambda base,pending:_render_layer_copy(
                    base,pending,region_scale,origin,region_cache.masks,
                ),
            )
            result=rendered.crop(crop)
            image.close()
            image=result
            used_viewport_layers=True
        else:
            _apply_layers(image,layers,scale,origin,original,progress,
                          mask_cache=region_cache.masks if use_region_cache else None,compact_tiles=compact_tiles)
        if crop:
            if not used_viewport_layers:
                result=image.crop(crop);image.close();image=result
        return image
    except BaseException:
        if image is not None:image.close()
        raise
    finally:
        if owns_original and original is not None:original.close()
