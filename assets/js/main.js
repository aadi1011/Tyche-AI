document.getElementById('yr').textContent=new Date().getFullYear();
window.addEventListener('scroll',function(){document.getElementById('hdr').classList.toggle('scrolled',window.scrollY>24);});
var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target);}});},{threshold:.1});
document.querySelectorAll('.reveal').forEach(function(el){if(!el.classList.contains('in'))io.observe(el);});
// subtle count-up on stats
function countUp(el){
  var target=parseFloat(el.getAttribute('data-count'));
  var pre=el.getAttribute('data-prefix')||'';
  var suf=el.getAttribute('data-suffix')||'';
  var dur=1400, start=null;
  function step(ts){
    if(!start)start=ts;
    var p=Math.min((ts-start)/dur,1);
    var eased=1-Math.pow(1-p,3);
    var val=Math.round(target*eased);
    el.textContent=pre+val.toLocaleString('en-IN')+suf;
    if(p<1)requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
var co=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){countUp(e.target);co.unobserve(e.target);}});},{threshold:.5});
document.querySelectorAll('[data-count]').forEach(function(el){co.observe(el);});
function mtoggle(){var n=document.querySelector('.navlinks');var on=n.style.display==='flex';n.style.display=on?'none':'flex';if(!on){n.style.flexDirection='column';n.style.position='absolute';n.style.top='74px';n.style.right='24px';n.style.background='#141418';n.style.padding='18px 28px';n.style.borderRadius='14px';n.style.border='1px solid var(--line2)';n.style.gap='16px';}}
document.querySelectorAll('.navlinks a').forEach(function(a){a.addEventListener('click',function(){if(window.innerWidth<=920){document.querySelector('.navlinks').style.display='none';}});});
function sendEnquiry(e){e.preventDefault();var n=document.getElementById('f_name').value.trim(),co=document.getElementById('f_co').value.trim(),p=document.getElementById('f_phone').value.trim(),top=document.getElementById('f_topic').value,m=document.getElementById('f_msg').value.trim();if(!n||!p){document.getElementById('formNote').textContent='Please enter your name and phone.';return;}var text='Free AI assessment, tyche.ai%0A%0AName: '+encodeURIComponent(n)+'%0ACompany: '+encodeURIComponent(co||'-')+'%0APhone: '+encodeURIComponent(p)+'%0AInterested in: '+encodeURIComponent(top)+'%0AMessage: '+encodeURIComponent(m||'-');window.open('https://wa.me/919840057282?text='+text,'_blank');document.getElementById('formNote').textContent='Opening WhatsApp…';}
