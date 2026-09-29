const test = require('node:test');
const assert = require('node:assert/strict');
const { errorHandler, AppError } = require('../dist/middleware/errorHandler');

for (const error of [new Error('stream failed'), new AppError('stream failed', 502)]) {
  test(`an already-started response delegates the original ${error.name} without writing JSON`, () => {
    const forwarded=[];
    const req={method:'GET',originalUrl:'/stream'};
    const res={headersSent:true,locals:{},status(){throw Error('must not send another response');}};
    assert.doesNotThrow(()=>errorHandler(error,req,res,e=>forwarded.push(e)));
    assert.deepEqual(forwarded,[error]);
  });
}
test('a destroyed response is not written again', () => {
  const res={destroyed:true,headersSent:false,locals:{},status(){throw Error('socket is closed');}};
  assert.doesNotThrow(()=>errorHandler(new AppError('cancelled'),{},res,()=>{throw Error('closed response needs no forwarding');}));
});
