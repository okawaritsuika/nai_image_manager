const test = require('node:test');
const assert = require('node:assert/strict');
const {groupCharacters, classify} = require('../static/daki_image_import_classification.js');

const records = [
    {token: 'blue eyes', tag: 'blue_eyes', regions: ['face'], sections: ['face.eyes']},
    {token: 'long hair', tag: 'long_hair', regions: ['face'], sections: ['face.hair']},
    {token: 'gloves', tag: 'gloves', regions: ['arms'], sections: ['arms.hands']},
    {token: 'shirt', tag: 'shirt', regions: ['chest'], sections: ['chest.clothes']},
];

test('character grouping retains weights, duplicates, source identity and unknown source text', () => {
    const chars = ['1.2::blue eyes, long hair::, [gloves], unknown tag, blue eyes', 'blue eyes, shirt'];
    const original = [...chars];
    const result = groupCharacters(chars, records);
    assert.deepEqual(chars, original);
    assert.deepEqual(result.groups, [
        {region:'face', characterIndex:0, prompt:'1.2::blue eyes::, blue eyes'},
        {region:'hair', characterIndex:0, prompt:'1.2::long hair::'},
        {region:'hands', characterIndex:0, prompt:'[gloves]'},
        {region:'face', characterIndex:1, prompt:'blue eyes'},
        {region:'clothes', characterIndex:1, prompt:'shirt'},
    ]);
    assert.equal(result.unknownCount, 1);
    assert.equal(result.classifiedCount, 6);
});

test('unknown, whole-body and malformed scopes are left unclassified', () => {
    const result = groupCharacters(['blue eyes', '{long hair', 'unknown', 'gloves'], [
        {...records[0], regions:['whole']}, {...records[2], regions:['unsupported']},
    ]);
    assert.deepEqual(result.groups, []);
    assert.equal(result.unknownCount, 3);
    assert.equal(result.invalidCharacters, 1);
});

test('multi-region meanings apply to each body region without changing source character', () => {
    const result = groupCharacters(['blue eyes'], [{...records[0], regions:['face','back']}]);
    assert.deepEqual(result.groups.map(group=>group.region), ['face','back']);
    assert(result.groups.every(group=>group.characterIndex===0 && group.prompt==='blue eyes'));
});

test('classification posts exact parsed unique leaves, excludes overlong tags and forwards cancellation', async () => {
    const controller = new AbortController(), calls=[];
    const result = await classify(['1.2::blue eyes, long hair::, blue eyes, '+ 'x'.repeat(501)], {
        signal:controller.signal,
        fetcher: async (url,options)=>{
            calls.push({url,options});
            return {ok:true,json:async()=>({status:'success',items:records.slice(0,2)})};
        },
    });
    assert.deepEqual(JSON.parse(calls[0].options.body), {tokens:['blue eyes','long hair']});
    assert.equal(calls[0].options.signal, controller.signal);
    assert.equal(result.groups.length,2);
    assert.equal(result.unknownCount,1);
});

test('large classification batches obey count and total text limits', async () => {
    const chars = [Array.from({length:2101},(_,i)=>'tag '+i).join(', ')];
    const batches=[];
    await classify(chars,{fetcher:async (url,options)=>{
        const tokens=JSON.parse(options.body).tokens; batches.push(tokens);
        return {ok:true,json:async()=>({status:'success',items:tokens.map(token=>({token,tag:null,regions:[],sections:[]}))})};
    }});
    assert.deepEqual(batches.map(batch=>batch.length),[2000,101]);
    assert(batches.every(batch=>batch.join('').length<=50000));
});

test('catalog failure and mismatched response reject without guessing meanings', async () => {
    await assert.rejects(classify(['blue eyes'],{fetcher:async()=>({ok:false,json:async()=>({status:'error',message:'catalog missing'})})}),/catalog missing/);
    await assert.rejects(classify(['blue eyes'],{fetcher:async()=>({ok:true,json:async()=>({status:'success',items:[records[1]]})})}),/부위 분류/);
});
