/* util.js - Utilities for Ezlo client API library

MIT License

Copyright (c) 2021 Patrick H. Rigney

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/

const version = 21364;

/**
 * Deep compare two values. This handles primitives, arrays and objects. They are considered "equal"
 * if their types are the same and their values are the same. For objects to be "equal" they must
 * contain identical keys and values (recursively, if needed). For array, they must be equal in length
 * and have equal values in the same order (recursively, if needed).
 *
 * @param {any} e1 - First value to compare
 * @param {any} e2 - Second value to compare
 * @return {boolean} - True if arguments are equal as defined above; false otherwise.
 */
function deepCompare( e1, e2 ) {
    function compareArrays( a, b ) {
        let n = a.length;
        if ( ! Array.isArray( b ) || n !== b.length ) {
            return false;
        }
        for ( let k=0; k<n; ++k ) {
            if ( typeof a[k] !== typeof b[k] ) {
                return false;
            }
            if ( Array.isArray( a[k] ) ) {
                if ( ! compareArrays( a[k], b[k] ) ) {
                    return false;
                }
            } else if ( null !== a[k] && "object" === typeof a[k] ) {
                if ( ! compareObjects( a[k], b[k] ) ) {
                    return false;
                }
            } else if ( a[k] !== b[k] ) {  /* type-constrained naturally */
                return false;
            }
        }
        return true;
    }

    function compareObjects( a, b ) {
        let ak = Object.keys( a ).sort();
        if ( null === b || "object" !== typeof( b ) || ! compareArrays( ak, Object.keys( b ).sort() ) ) {
            return false;
        }
        let n = ak.length;
        for ( let k=0; k<n; ++k ) {
            let key = ak[ k ];
            if ( Array.isArray( a[key] ) ) {
                if ( ! compareArrays( a[key], b[key] ) ) {
                    return false;
                }
            } else if ( null === a[key] ) {
                if ( null !== b[key] ) {
                    return false;
                }
            } else if ( "object" === typeof a[key] ) {
                if ( ! compareObjects( a[key], b[key] ) ) {
                    return false;
                }
            } else if ( a[key] !== b[key] ) {  /* type-constrained naturally */
                return false;
            }
        }
        return true;
    }

    if ( Array.isArray( e1 ) ) {
        return compareArrays( e1, e2 );
    } else if ( null !== e1 && "object" === typeof e1 ) {
        return compareObjects( e1, e2 );
    }
    return e1 === e2;
}

var runInSequence = async function( implementationArray ) {
    // console.log("Starting sequence of", implementationArray.length, " Promises...");
    return new Promise( ( wrapper_resolve, wrapper_reject ) => {
        let index = 0;
        var next_impl = function( val ) {
            if ( index >= implementationArray.length ) {
                wrapper_resolve( val );
                return;
            }

            // console.log("Starting Promise", index, " of ", implementationArray.length);
            let impl = implementationArray[ index ];
            try {
                impl( function( result ) {
                        /* resolve */
                        // console.log("Promise", index," resolved");
                        ++index;
                        next_impl( result );
                    }, function( err ) {
                        /* reject */
                        // console.log("Promise sequence BROKEN",index,err);
                        wrapper_reject( err );
                    });
            } catch( err ) {
                if ( err instanceof Error ) {
                    err.index = index;
                }
                wrapper_reject( err );
            }
        };
        next_impl();
    });
};

module.exports = {
    deepCompare: deepCompare,
    runInSequence: runInSequence
};

