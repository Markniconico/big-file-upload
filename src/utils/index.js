//将字节转换为kb
const transformByte = function(val) {
    return Number((val / 1024).toFixed(0));
}

export {
    transformByte
}