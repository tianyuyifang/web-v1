/**
 * DES as QQ Music implements it, which is not DES.
 *
 * QRC lyrics are hex, encrypted, then zlib-compressed. The encryption looks
 * like 3DES-ECB and is not: the implementation QQ ships is a fork of a public
 * DES with four deliberate corruptions, so Node's own `des-ede3` decrypts it
 * to noise. Verified — the standard cipher produces bytes that zlib refuses,
 * while this one produces the 0x78 0x9c header and inflates to valid XML.
 *
 * The four differences from the original (B-Con/crypto-algorithms), kept here
 * because they look like typos and someone will eventually try to "fix" them:
 *
 *   bitnum       byte index is (b/32)*4+3-(b%32)/8 rather than b/8, which
 *                swaps word order
 *   sbox2        entry `14` replaced by `15`
 *   sbox4        entry `1`  replaced by `10`
 *   key schedule key_compression index offset 27 rather than 28
 *   inverse_permutation output bytes emitted 3,2,1,0,7,6,5,4
 *
 * None of this is a secret and none of it is a credential: the keys are
 * published in several open-source players. It is obfuscation, so it is
 * treated as a format detail rather than as security.
 *
 * Reference: https://github.com/chenmozhijin/LDDC (decryptor/__init__.py),
 * https://github.com/wangqr/QQMusicDES, https://github.com/xmcp/QRCD
 */


const SBOX=[14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7,0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0,15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13,15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10,3,13,4,7,15,2,8,15,12,0,1,10,6,9,11,5,0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15,13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9,10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8,13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7,1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12,7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15,13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4,3,15,0,6,10,10,13,8,9,4,5,11,12,7,2,14,2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9,14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14,11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3,12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11,10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6,4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13,4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1,13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2,6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12,13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7,1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2,7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8,2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11];
const KRS=[1,1,2,2,2,2,2,2,1,2,2,2,2,2,2,1];
const KPC=[56,48,40,32,24,16,8,0,57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35];
const KPD=[62,54,46,38,30,22,14,6,61,53,45,37,29,21,13,5,60,52,44,36,28,20,12,4,27,19,11,3];
const KC=[13,16,10,23,0,4,2,27,14,5,20,9,22,18,11,3,25,7,15,6,26,19,12,1,40,51,30,36,46,54,29,39,50,44,32,47,43,48,38,55,33,52,45,41,49,35,28,31];
const u=x=>x>>>0;
// BUGGY bitnum: byte index is (b/32)*4+3-(b%32)/8  (word-swapped vs standard DES)
const bitnum=(a,b,c)=>u(((a[Math.floor(b/32)*4+3-Math.floor((b%32)/8)]>>>(7-(b%8)))&1)<<c);
const bitnumIntr=(a,b,c)=>u(((u(a)>>>(31-b))&1)<<c);
const bitnumIntl=(a,b,c)=>u(u(u(a<<b)&0x80000000)>>>c);
const sboxBit=a=>(a&32)|((a&31)>>>1)|((a&1)<<4);
const IPT=[[57,49,41,33,25,17,9,1,59,51,43,35,27,19,11,3,61,53,45,37,29,21,13,5,63,55,47,39,31,23,15,7],
           [56,48,40,32,24,16,8,0,58,50,42,34,26,18,10,2,60,52,44,36,28,20,12,4,62,54,46,38,30,22,14,6]];
function ip(d){const o=[0,0];for(let h=0;h<2;h++){let s=0;for(let i=0;i<32;i++)s=u(s|bitnum(d,IPT[h][i],31-i));o[h]=s;}return o;}
function invp(s0,s1){const d=Buffer.alloc(8);
d[0]=bitnumIntr(s1,4,7)|bitnumIntr(s0,4,6)|bitnumIntr(s1,12,5)|bitnumIntr(s0,12,4)|bitnumIntr(s1,20,3)|bitnumIntr(s0,20,2)|bitnumIntr(s1,28,1)|bitnumIntr(s0,28,0);
d[1]=bitnumIntr(s1,5,7)|bitnumIntr(s0,5,6)|bitnumIntr(s1,13,5)|bitnumIntr(s0,13,4)|bitnumIntr(s1,21,3)|bitnumIntr(s0,21,2)|bitnumIntr(s1,29,1)|bitnumIntr(s0,29,0);
d[2]=bitnumIntr(s1,6,7)|bitnumIntr(s0,6,6)|bitnumIntr(s1,14,5)|bitnumIntr(s0,14,4)|bitnumIntr(s1,22,3)|bitnumIntr(s0,22,2)|bitnumIntr(s1,30,1)|bitnumIntr(s0,30,0);
d[3]=bitnumIntr(s1,7,7)|bitnumIntr(s0,7,6)|bitnumIntr(s1,15,5)|bitnumIntr(s0,15,4)|bitnumIntr(s1,23,3)|bitnumIntr(s0,23,2)|bitnumIntr(s1,31,1)|bitnumIntr(s0,31,0);
d[4]=bitnumIntr(s1,0,7)|bitnumIntr(s0,0,6)|bitnumIntr(s1,8,5)|bitnumIntr(s0,8,4)|bitnumIntr(s1,16,3)|bitnumIntr(s0,16,2)|bitnumIntr(s1,24,1)|bitnumIntr(s0,24,0);
d[5]=bitnumIntr(s1,1,7)|bitnumIntr(s0,1,6)|bitnumIntr(s1,9,5)|bitnumIntr(s0,9,4)|bitnumIntr(s1,17,3)|bitnumIntr(s0,17,2)|bitnumIntr(s1,25,1)|bitnumIntr(s0,25,0);
d[6]=bitnumIntr(s1,2,7)|bitnumIntr(s0,2,6)|bitnumIntr(s1,10,5)|bitnumIntr(s0,10,4)|bitnumIntr(s1,18,3)|bitnumIntr(s0,18,2)|bitnumIntr(s1,26,1)|bitnumIntr(s0,26,0);
d[7]=bitnumIntr(s1,3,7)|bitnumIntr(s0,3,6)|bitnumIntr(s1,11,5)|bitnumIntr(s0,11,4)|bitnumIntr(s1,19,3)|bitnumIntr(s0,19,2)|bitnumIntr(s1,27,1)|bitnumIntr(s0,27,0);
return d;}
function f(state,key){
 let t1=u(bitnumIntl(state,31,0)|u((state&0xf0000000)>>>1)|bitnumIntl(state,4,5)|bitnumIntl(state,3,6)|u((state&0x0f000000)>>>3)|bitnumIntl(state,8,11)|bitnumIntl(state,7,12)|u((state&0x00f00000)>>>5)|bitnumIntl(state,12,17)|bitnumIntl(state,11,18)|u((state&0x000f0000)>>>7)|bitnumIntl(state,16,23));
 let t2=u(bitnumIntl(state,15,0)|u((state&0x0000f000)<<15)|bitnumIntl(state,20,5)|bitnumIntl(state,19,6)|u((state&0x00000f00)<<13)|bitnumIntl(state,24,11)|bitnumIntl(state,23,12)|u((state&0x000000f0)<<11)|bitnumIntl(state,28,17)|bitnumIntl(state,27,18)|u((state&0x0000000f)<<9)|bitnumIntl(state,0,23));
 const lrg=[u(t1>>>24)&255,u(t1>>>16)&255,u(t1>>>8)&255,u(t2>>>24)&255,u(t2>>>16)&255,u(t2>>>8)&255];
 for(let i=0;i<6;i++)lrg[i]^=key[i];
 let st=u(u(SBOX[0*64+sboxBit(lrg[0]>>>2)]<<28)|u(SBOX[1*64+sboxBit(((lrg[0]&3)<<4)|(lrg[1]>>>4))]<<24)|u(SBOX[2*64+sboxBit(((lrg[1]&15)<<2)|(lrg[2]>>>6))]<<20)|u(SBOX[3*64+sboxBit(lrg[2]&63)]<<16)|u(SBOX[4*64+sboxBit(lrg[3]>>>2)]<<12)|u(SBOX[5*64+sboxBit(((lrg[3]&3)<<4)|(lrg[4]>>>4))]<<8)|u(SBOX[6*64+sboxBit(((lrg[4]&15)<<2)|(lrg[5]>>>6))]<<4)|SBOX[7*64+sboxBit(lrg[5]&63)]);
 return u(bitnumIntl(st,15,0)|bitnumIntl(st,6,1)|bitnumIntl(st,19,2)|bitnumIntl(st,20,3)|bitnumIntl(st,28,4)|bitnumIntl(st,11,5)|bitnumIntl(st,27,6)|bitnumIntl(st,16,7)|bitnumIntl(st,0,8)|bitnumIntl(st,14,9)|bitnumIntl(st,22,10)|bitnumIntl(st,25,11)|bitnumIntl(st,4,12)|bitnumIntl(st,17,13)|bitnumIntl(st,30,14)|bitnumIntl(st,9,15)|bitnumIntl(st,1,16)|bitnumIntl(st,7,17)|bitnumIntl(st,23,18)|bitnumIntl(st,13,19)|bitnumIntl(st,31,20)|bitnumIntl(st,26,21)|bitnumIntl(st,2,22)|bitnumIntl(st,8,23)|bitnumIntl(st,18,24)|bitnumIntl(st,12,25)|bitnumIntl(st,29,26)|bitnumIntl(st,5,27)|bitnumIntl(st,21,28)|bitnumIntl(st,10,29)|bitnumIntl(st,3,30)|bitnumIntl(st,24,31));
}
function keySchedule(key,decrypt){
 const sch=Array.from({length:16},()=>[0,0,0,0,0,0]);
 let c=0,d=0;
 for(let i=0;i<28;i++)c=u(c|bitnum(key,KPC[i],31-i));
 for(let i=0;i<28;i++)d=u(d|bitnum(key,KPD[i],31-i));
 for(let i=0;i<16;i++){
  c=u(u(u(c<<KRS[i])|u(c>>>(28-KRS[i])))&0xfffffff0);
  d=u(u(u(d<<KRS[i])|u(d>>>(28-KRS[i])))&0xfffffff0);
  const tg=decrypt?15-i:i;
  for(let j=0;j<6;j++)sch[tg][j]=0;
  for(let j=0;j<24;j++)sch[tg][j>>>3]|=bitnumIntr(c,KC[j],7-(j%8));
  for(let j=24;j<48;j++)sch[tg][j>>>3]|=bitnumIntr(d,KC[j]-27,7-(j%8)); // BUG: -27 not -28
 }
 return sch;
}
function desBlock(blk,sch){let a=ip(blk),s0=a[0],s1=a[1];
 for(let i=0;i<15;i++){const p=s1;s1=u(f(s1,sch[i])^s0);s0=p;}
 s0=u(f(s1,sch[15])^s0);return invp(s0,s1);}
function tripleDesDecrypt(buf,key24){
 const s=[keySchedule(key24.slice(16,24),true),keySchedule(key24.slice(8,16),false),keySchedule(key24.slice(0,8),true)];
 const out=Buffer.alloc(buf.length);
 for(let i=0;i<buf.length;i+=8){let b=buf.slice(i,i+8);
  b=desBlock(b,s[0]);b=desBlock(b,s[1]);b=desBlock(b,s[2]);b.copy(out,i);}
 return out;}
module.exports={tripleDesDecrypt};
